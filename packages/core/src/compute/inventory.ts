/**
 * L5 · compute/inventory —— 库存覆盖与补货建议（PRD E1–E4）
 *
 * 方法论：
 *   日均销量取**近 30 天实测**（无数据 → avgDailySales=null，整条转 unknown，
 *   不给一个"看起来像真的"的假覆盖天数 —— C7）。
 *   覆盖天数 = (现有 + 在途) / 日均
 *   补货点   = 日均 × (提前期 + 安全天数)
 *   建议量   = max(0, 覆盖到「提前期 + 安全 + 目标周转」所需 − 现有 − 在途)，并向上取 MOQ
 */

import type { ISODate } from '../model/daily.ts';
import type { SkuDaily } from '../model/sku.ts';
import type { InventoryCoverage, InventoryItem } from '../model/supply.ts';

export interface InventoryOptions {
  /** 观测基准日（由调用方注入） */
  today: ISODate;
  /** 日均销量的回看天数，默认 30 */
  lookbackDays?: number;
  /** 目标周转天数（补货后希望覆盖到多少天），默认 = 提前期 + 安全 + 30 */
  targetCoverDays?: number;
  /** 在途是否计入可售覆盖，默认 true */
  includeInTransit?: boolean;
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function addDays(iso: ISODate, n: number): ISODate {
  const t = new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 计算某 SKU 的近 N 天日均销量；无任何数据返回 null（不返回 0，避免假健康） */
export function avgDailySales(
  skuDaily: readonly SkuDaily[],
  sku: string,
  today: ISODate,
  lookbackDays = 30,
): { value: number | null; observedDays: number } {
  const from = addDays(today, -(lookbackDays - 1));
  const rows = skuDaily.filter((r) => r.sku === sku && r.date >= from && r.date <= today);
  if (!rows.length) return { value: null, observedDays: 0 };
  const days = new Set(rows.map((r) => r.date)).size;
  if (days === 0) return { value: null, observedDays: 0 };
  const qty = rows.reduce((a, r) => a + r.qty, 0);
  return { value: round2(qty / days), observedDays: days };
}

/** 库存覆盖分析（每个 item 一条，SKU 无销售数据时 status='unknown'） */
export function inventoryCoverage(
  items: readonly InventoryItem[],
  skuDaily: readonly SkuDaily[],
  opts: InventoryOptions,
): InventoryCoverage[] {
  const { today, lookbackDays = 30, includeInTransit = true } = opts;

  return items.map((it) => {
    const { value: ads, observedDays } = avgDailySales(skuDaily, it.sku, today, lookbackDays);
    const target = opts.targetCoverDays ?? it.leadTimeDays + it.safetyDays + 30;
    const available = includeInTransit ? it.onHand + it.inTransit : it.onHand;
    const assumptions: string[] = [];
    if (includeInTransit) assumptions.push('在途库存已计入可售覆盖');
    if (observedDays > 0) assumptions.push(`日均销量基于近 ${observedDays} 天实测`);

    if (ads === null || ads <= 0) {
      return {
        sku: it.sku,
        onHand: it.onHand,
        inTransit: it.inTransit,
        avgDailySales: ads,
        coverDays: null,
        coverDaysOnHand: null,
        reorderPoint: null,
        suggestedQty: 0,
        status: 'unknown' as const,
        message: `尚无近 ${lookbackDays} 天的单品销售数据，无法判断库存健康度。请先导入 SKU×日 数据。`,
        assumptions,
      };
    }

    const coverDays = round2(available / ads);
    const coverDaysOnHand = round2(it.onHand / ads);
    const reorderPoint = round2(ads * (it.leadTimeDays + it.safetyDays));
    const need = ads * target - available;
    let suggested = Math.max(0, Math.ceil(need));
    if (suggested > 0 && it.moq && it.moq > 0) {
      suggested = Math.ceil(suggested / it.moq) * it.moq;
      assumptions.push(`已按最小起订量 ${it.moq} 向上取整`);
    }

    let status: InventoryCoverage['status'];
    let message: string;
    if (it.onHand <= 0 && it.inTransit <= 0) {
      status = 'stockout';
      message = `已断货。日均销 ${ads}/天，建议立即补 ${suggested} 瓶。`;
    } else if (coverDays < it.leadTimeDays) {
      status = 'urgent';
      message = `可售 ${coverDays} 天，短于提前期 ${it.leadTimeDays} 天，存在断货风险。建议补 ${suggested} 瓶。`;
    } else if (coverDays < it.leadTimeDays + it.safetyDays) {
      status = 'watch';
      message = `可售 ${coverDays} 天，已进入安全库存区间（补货点 ${reorderPoint} 瓶），建议安排补货 ${suggested} 瓶。`;
    } else if (coverDays > target * 2) {
      status = 'overstock';
      message = `可售 ${coverDays} 天，远超目标周转 ${round2(target)} 天，占用资金偏多，建议暂停补货并促销去库存。`;
    } else {
      status = 'healthy';
      message = `可售 ${coverDays} 天，库存健康。`;
    }

    return {
      sku: it.sku,
      onHand: it.onHand,
      inTransit: it.inTransit,
      avgDailySales: ads,
      coverDays,
      coverDaysOnHand,
      reorderPoint,
      suggestedQty: suggested,
      status,
      message,
      assumptions,
    };
  });
}

/** 汇总：按状态分桶 + 待补货总金额（按 BOM 单位成本） */
export function inventorySummary(
  cov: readonly InventoryCoverage[],
  unitCostOf: (sku: string) => number,
): {
  counts: Record<InventoryCoverage['status'], number>;
  suggestedTotalQty: number;
  suggestedTotalAmount: number;
  /** 需要人工关注的 SKU（断货/紧急/待观察） */
  attention: string[];
} {
  const counts: Record<InventoryCoverage['status'], number> = {
    stockout: 0,
    urgent: 0,
    watch: 0,
    healthy: 0,
    overstock: 0,
    unknown: 0,
  };
  let suggestedTotalQty = 0;
  let suggestedTotalAmount = 0;
  const attention: string[] = [];
  for (const c of cov) {
    counts[c.status] += 1;
    if (c.suggestedQty > 0) {
      suggestedTotalQty += c.suggestedQty;
      suggestedTotalAmount += c.suggestedQty * unitCostOf(c.sku);
    }
    if (c.status === 'stockout' || c.status === 'urgent' || c.status === 'watch') attention.push(c.sku);
  }
  return {
    counts,
    suggestedTotalQty,
    suggestedTotalAmount: round2(suggestedTotalAmount),
    attention,
  };
}
