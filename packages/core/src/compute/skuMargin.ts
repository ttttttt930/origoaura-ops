/**
 * L5 · compute/skuMargin —— 单品真实毛利（PRD B3，V10 核心增量）
 *
 * 与 V9 的本质区别：
 *   V9 只有「综合单瓶成本 × 总销量」的粗算，且成本口径三轨漂移
 *     （内置 13.28 / 快照 14.59 / 税基 13.28），单品盈亏无从判断。
 *   V10 按 **SKU × 平台** 逐行计算，物料成本一律取 SkuMaster.unitCost（真实 BOM 核定值），
 *         永远不做等权估算（等权只允许出现在驾驶舱的"综合单瓶成本"角标里）。
 *
 * ADR-08：源数据缺失时返回**结构化 DataGap**，绝不返回 null / 补 0 假数据。
 */

import type { Platform } from '../model/daily.ts';
import type {
  AllocationStrategy,
  DataGap,
  SkuDaily,
  SkuMargin,
  SkuMaster,
} from '../model/sku.ts';
import { SKU_DAILY_GAP, SKU_MASTER_GAP, COST_POLICY_GAP, cogsUnitCost } from '../model/sku.ts';
import type { CostPolicy } from '../model/finance.ts';
import { allocatePromotion } from './allocation.ts';

export interface SkuMarginOptions {
  /** 统计区间（含端点）；缺省为全期 */
  from?: string;
  to?: string;
  /** 推广分摊策略，默认 by-revenue */
  strategy?: AllocationStrategy;
  /**
   * 各平台在该区间的实际推广费总额。
   * 传入则用真实池子分摊；未传时退化为「直连之和」，并在 assumptions 中如实标注。
   */
  platformPromotionPool?: Partial<Record<Platform, number>>;
  /** 物流按「一单一瓶」近似折算时使用的订单数系数（默认 1） */
  ordersPerUnit?: number;
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
function rate(v: number): number {
  return Math.round((v + Number.EPSILON) * 10000) / 10000;
}

/** 单品 ROI 阈值：≥1.5 安全 / 1–1.5 保本线上 / <1 亏损 */
export function roiZone(roi: number | null): 'safe' | 'warning' | 'loss' | 'unknown' {
  if (roi === null || !Number.isFinite(roi)) return 'unknown';
  if (roi >= 1.5) return 'safe';
  if (roi >= 1) return 'warning';
  return 'loss';
}

/**
 * 计算 SKU × 平台 的真实毛利明细。
 * 返回 `SkuMargin[]`（可正常计算）或 `DataGap`（源数据缺口）。
 */
export function computeSkuMargins(
  skuDaily: readonly SkuDaily[],
  skuMaster: readonly SkuMaster[],
  costPolicy: CostPolicy | null,
  opts: SkuMarginOptions = {},
): SkuMargin[] | DataGap {
  if (!skuMaster.length) return SKU_MASTER_GAP;
  if (!skuDaily.length) return SKU_DAILY_GAP;
  if (!costPolicy) return COST_POLICY_GAP;

  const { from = '0000-01-01', to = '9999-12-31' } = opts;
  const strategy: AllocationStrategy = opts.strategy ?? 'by-revenue';
  const ordersPerUnit = opts.ordersPerUnit ?? 1;

  const masterBySku = new Map<string, SkuMaster>();
  for (const m of skuMaster) masterBySku.set(m.sku, m);

  // 先剔除主数据里没有的 SKU —— 否则它们会参与推广费分摊、分走一笔预算，
  // 随后又在输出时被 `continue` 丢掉，导致「平台内分摊合计 < 池子」（可对账性被破坏）。
  // 未映射 SKU 由 DQ 规则 SKU_UNMAPPED 单独告警。
  const rows = skuDaily.filter(
    (r) => r.date >= from && r.date <= to && masterBySku.has(r.sku),
  );
  if (!rows.length) return SKU_DAILY_GAP;

  // ---- 1) 按 sku × platform 归组 ----
  type Cell = {
    sku: string;
    platform: Platform;
    qty: number;
    revenue: number;
    refundQty: number;
    refund: number;
    direct: number;
    hasDirect: boolean;
  };
  const cells = new Map<string, Cell>();
  for (const r of rows) {
    const key = `${r.sku}@@${r.platform}`;
    const c = cells.get(key) ?? {
      sku: r.sku,
      platform: r.platform,
      qty: 0,
      revenue: 0,
      refundQty: 0,
      refund: 0,
      direct: 0,
      hasDirect: false,
    };
    c.qty += r.qty;
    c.revenue += r.avgPrice * r.qty;
    c.refundQty += r.refundQty;
    c.refund += r.refundAmount;
    if (r.promotionDirect !== undefined && r.promotionDirect !== null) {
      c.direct += r.promotionDirect;
      c.hasDirect = true;
    }
    cells.set(key, c);
  }

  // ---- 2) 按平台分摊推广费 ----
  const promotionByCell = new Map<string, { promotion: number; allocated: boolean }>();
  const platforms = [...new Set([...cells.values()].map((c) => c.platform))];
  for (const p of platforms) {
    const inPlatform = [...cells.entries()].filter(([, c]) => c.platform === p);
    const directSum = inPlatform.reduce((a, [, c]) => a + c.direct, 0);
    const pool = opts.platformPromotionPool?.[p];
    const effectivePool = pool !== undefined && pool > directSum ? pool : directSum;
    const allocated = allocatePromotion(
      inPlatform.map(([key, c]) => ({
        key,
        revenue: c.revenue,
        qty: c.qty,
        promotionDirect: c.hasDirect ? c.direct : undefined,
      })),
      effectivePool,
      strategy,
    );
    for (const a of allocated) {
      promotionByCell.set(a.key, { promotion: a.promotion, allocated: a.allocated });
    }
  }

  const poolMissing = opts.platformPromotionPool === undefined;
  const commissionRate = costPolicy.platformCommissionRate;

  // ---- 3) 逐格计算 ----
  const out: SkuMargin[] = [];
  for (const [key, c] of cells) {
    // rows 已在上面过滤过，这里必定命中；保留断言防止后续改动重新引入「分摊漏算」
    const master = masterBySku.get(c.sku)!;

    const revenue = round2(c.revenue);
    const refund = round2(c.refund);
    // 真实 BOM：单瓶成本 × 瓶数。这里**不引入任何估算**。
    // 取 COGS 口径（不含试香卡）：试香卡是获客物料，计入会系统性低估毛利。
    const cogs = round2(cogsUnitCost(master) * c.qty);
    const commission = round2(revenue * (commissionRate[c.platform] ?? 0));
    const paymentFee = round2(revenue * costPolicy.paymentFeeRate);
    const orders = Math.round(c.qty * ordersPerUnit);
    const logistics = round2(orders * costPolicy.logisticsPerOrder);
    const pa = promotionByCell.get(key) ?? { promotion: 0, allocated: true };
    const promotion = round2(pa.promotion);

    const net = round2(revenue - refund - cogs - commission - paymentFee - logistics - promotion);
    const denom = cogs + promotion;
    const roiValue = denom > 0 ? round2(revenue / denom) : null;

    const assumptions: string[] = [];
    if (pa.allocated) {
      assumptions.push(
        poolMissing
          ? `推广费为按${strategy === 'by-qty' ? '销量' : '收入'}分摊的估算值（未提供平台推广费池）`
          : `推广费为按${strategy === 'by-qty' ? '销量' : '收入'}分摊值，非单品直连`,
      );
    }
    if (ordersPerUnit === 1) assumptions.push('物流费按「一单一瓶」近似（无订单数维度）');
    for (const k of excludedKeys(costPolicy)) assumptions.push(`${k}成本未计入（master 数据缺失）`);

    out.push({
      sku: c.sku,
      platform: c.platform,
      qty: c.qty,
      revenue,
      refund,
      cogs,
      commission,
      paymentFee,
      logistics,
      promotion,
      allocated: pa.allocated,
      net,
      roi: roiValue ?? 0,
      grossMarginRate: revenue > 0 ? rate((revenue - cogs) / revenue) : 0,
      netMarginRate: revenue > 0 ? rate(net / revenue) : 0,
      assumptions,
    });
  }

  return out.sort((a, b) => b.revenue - a.revenue);
}

function excludedKeys(p: CostPolicy): string[] {
  const out: string[] = [];
  if (!p.fillingPerUnit) out.push('灌装');
  if (!p.laborPerUnit) out.push('人工');
  if (!p.packagingLossRate) out.push('包材损耗');
  return out;
}

/** 把 sku×platform 明细汇总到 sku 粒度（产品页榜单用） */
export interface SkuRollup {
  sku: string;
  productLine: string;
  qty: number;
  revenue: number;
  refund: number;
  cogs: number;
  promotion: number;
  net: number;
  roi: number;
  netMarginRate: number;
  /** 该 SKU 的推广是否为分摊（任一平台分摊则为 true） */
  allocated: boolean;
  /** 命中的平台数 */
  platformCount: number;
  assumptions: string[];
}

export function rollupBySku(margins: readonly SkuMargin[]): SkuRollup[] {
  const map = new Map<string, SkuMargin[]>();
  for (const m of margins) {
    const list = map.get(m.sku);
    if (list) list.push(m);
    else map.set(m.sku, [m]);
  }
  return [...map.entries()]
    .map(([sku, list]) => {
      const qty = list.reduce((a, m) => a + m.qty, 0);
      const revenue = round2(list.reduce((a, m) => a + m.revenue, 0));
      const refund = round2(list.reduce((a, m) => a + m.refund, 0));
      const cogs = round2(list.reduce((a, m) => a + m.cogs, 0));
      const promotion = round2(list.reduce((a, m) => a + m.promotion, 0));
      const net = round2(list.reduce((a, m) => a + m.net, 0));
      const denom = cogs + promotion;
      const assumptions = [...new Set(list.flatMap((m) => m.assumptions))];
      return {
        sku,
        productLine: '',
        qty,
        revenue,
        refund,
        cogs,
        promotion,
        net,
        roi: denom > 0 ? round2(revenue / denom) : 0,
        netMarginRate: revenue > 0 ? rate(net / revenue) : 0,
        allocated: list.some((m) => m.allocated),
        platformCount: new Set(list.map((m) => m.platform)).size,
        assumptions,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);
}

/** 单品在渠道中的分布（产品页"渠道下钻"用） */
export function skuPlatformBreakdown(
  margins: readonly SkuMargin[],
  sku: string,
): { platform: Platform; qty: number; revenue: number; share: number; net: number }[] {
  const rows = margins.filter((m) => m.sku === sku);
  const total = rows.reduce((a, m) => a + m.revenue, 0);
  return rows
    .map((m) => ({
      platform: m.platform,
      qty: m.qty,
      revenue: m.revenue,
      share: total > 0 ? rate(m.revenue / total) : 0,
      net: m.net,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}
