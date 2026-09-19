/**
 * L5 · model/supply —— 供应链 / 库存模型（V10 新增，PRD E1–E4）
 *
 * 修复 V9 遗留缺陷：供应链接口读的是 `it.bom[].supplier` / `c.min_price`，
 * 而真实快照里字段叫 `it.components[].supplier` / `unit_price`，
 * 导致「供应商数」恒为 0、采购金额恒为空（界面看起来"正常"其实是空数据）。
 * V10 起**只有一份**结构：SkuMaster.bom（见 model/sku.ts），
 * 供应商 / 单价一律从该结构派生，杜绝双结构漂移。
 *
 * 本文件零 IO、零副作用。
 */

import type { ISODate } from './daily.ts';
import type { SkuMaster } from './sku.ts';

/** 单个 SKU 的库存与补货参数（data/master/inventory.json） */
export interface InventoryItem {
  sku: string;
  /** 现有库存（瓶） */
  onHand: number;
  /** 在途（瓶） */
  inTransit: number;
  /** 采购提前期（天）：下单到入库 */
  leadTimeDays: number;
  /** 安全库存天数：抵御波动 */
  safetyDays: number;
  /** 数据观测日（用于 DQ 判定「库存数据是否过期」） */
  asOf: ISODate;
  /**
   * 最小起订量（瓶）。若为 0 表示不约束。
   */
  moq?: number;
  note?: string;
}

/** 库存覆盖分析结果（compute/inventory.ts 的产出形态） */
export interface InventoryCoverage {
  sku: string;
  onHand: number;
  inTransit: number;
  /** 日均销量（瓶/天），来自近 30 天实测；无数据为 null */
  avgDailySales: number | null;
  /** 可售天数 = (onHand + inTransit) / avgDailySales；无销量数据为 null */
  coverDays: number | null;
  /** 不含在途的可售天数 */
  coverDaysOnHand: number | null;
  /** 补货点 = avgDailySales × (leadTime + safety) */
  reorderPoint: number | null;
  /** 建议补货量（已按 MOQ 向上取整）；无需补货为 0 */
  suggestedQty: number;
  /** 状态 */
  status: 'stockout' | 'urgent' | 'watch' | 'healthy' | 'overstock' | 'unknown';
  /** 人话结论 */
  message: string;
  /** 计算所用假设（C7：必须展示） */
  assumptions: string[];
}

/** 供应商聚合视图 —— 替代 V9 那个「恒为 0」的实现 */
export interface SupplierSummary {
  supplier: string;
  /** 供应的组件数 */
  componentCount: number;
  /** 覆盖的 SKU 数 */
  skuCount: number;
  /** 单个组件加权均价（元），用于比价 */
  avgUnitPrice: number;
  /** 示例组件名（前 3 个） */
  sampleComponents: string[];
}

/**
 * BOM 明细可信度自检（C7：假数据必须标注）。
 * 只要有一款 SKU 的 bom 是占位结构，供应链页就必须打「结构示意」角标。
 */
export interface BomQuality {
  verified: number;
  placeholder: number;
  allVerified: boolean;
  note: string;
}

export function bomQuality(skuMaster: readonly SkuMaster[]): BomQuality {
  const placeholder = skuMaster.filter((s) => s.bomSource === 'placeholder').length;
  const verified = skuMaster.length - placeholder;
  return {
    verified,
    placeholder,
    allVerified: placeholder === 0,
    note:
      placeholder === 0
        ? '全部 SKU 的 BOM 明细均来自实采报价/采购单，可逐条追溯。'
        : `有 ${placeholder} 款 SKU 的 BOM 明细为占位结构（仅单位成本为实采值），` +
          `供应商集中度可供参考，但逐组件核价不可用。请从采购报价表补齐明细。`,
  };
}

/**
 * 从 SKU 主数据派生供应商聚合。
 * **唯一事实源**：只读 SkuMaster.bom，不再有第二个字段名。
 */
export function supplierSummary(skuMaster: readonly SkuMaster[]): SupplierSummary[] {
  const map = new Map<string, { components: Set<string>; skus: Set<string>; sum: number; n: number }>();
  for (const s of skuMaster) {
    for (const line of s.bom) {
      const supplier = (line.supplier ?? '').trim();
      if (!supplier || supplier === '未标注') continue;
      const cur = map.get(supplier) ?? { components: new Set(), skus: new Set(), sum: 0, n: 0 };
      cur.components.add(line.name);
      cur.skus.add(s.sku);
      cur.sum += line.unitPrice;
      cur.n += 1;
      map.set(supplier, cur);
    }
  }
  return [...map.entries()]
    .map(([supplier, v]) => ({
      supplier,
      componentCount: v.components.size,
      skuCount: v.skus.size,
      avgUnitPrice: v.n ? Math.round((v.sum / v.n) * 100) / 100 : 0,
      sampleComponents: [...v.components].slice(0, 3),
    }))
    .sort((a, b) => b.skuCount - a.skuCount || a.supplier.localeCompare(b.supplier));
}

/** 采购行 —— 一个 SKU 的一次采购 */
export interface PurchaseLine {
  sku: string;
  /** 采购瓶数 */
  qty: number;
}

/**
 * 采购金额（按 BOM 真实单位成本 × 采购量）。
 * V9 读 `min_price` 恒为空；此处只认 SkuMaster.unitCost。
 */
export function purchaseAmount(lines: readonly PurchaseLine[], skuMaster: readonly SkuMaster[]): number {
  const byName = new Map<string, SkuMaster>();
  for (const s of skuMaster) byName.set(s.sku, s);
  let total = 0;
  for (const l of lines) {
    const s = byName.get(l.sku);
    if (!s) continue;
    total += s.unitCost * l.qty;
  }
  return Math.round((total + Number.EPSILON) * 100) / 100;
}
