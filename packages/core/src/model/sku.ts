/**
 * L5 · model/sku —— SKU 维度模型（V10 新增，PRD B）
 *
 * 设计约束：
 *  BOM 单位成本取**真实 BOM 核定值**（11.34–18.49），禁止等权估算
 *  （V5/V6 遗留问题：内置 13.28 vs 快照 14.59，口径漂移）。
 *  SKU×日 数据是**可选维度**：平台导不出时返回结构化「数据缺口」对象，
 *  前端渲染空态 + 三步入手指引，绝不拿假设当真值（C7 / ADR-08）。
 */

import type { ISODate, Platform } from './daily.ts';

/** SKU 主数据（data/master/sku-bom.json 的结构） */
export interface SkuMaster {
  /** 商品名，与平台导出、BOM 表一致的唯一键，如 '不在场50ml' */
  sku: string;
  spec: string;
  productLine: string;
  /** 含包装单位成本（BOM 核定值，元/瓶） */
  unitCost: number;
  bom: BomLine[];
  /** 参考售价；可被实际成交均价覆盖 */
  defaultPrice?: number;
  status: 'active' | 'halted';
  /**
   * 预估月销量（瓶）。仅用于**无 SKU 实际数据时**给单瓶成本加权，
   * 从而算出驾驶舱的"综合单瓶物料成本"。属于假设值，使用时必须打「估算」角标
   * （SAD §4.1：无源数据时回落内置 BOM + 标注假设，沿用 v5 getProducts 回落思想）。
   */
  estMonthlyQty?: number;
  /**
   * 成本口径版本（口径变更需版本化，避免历史对比失真 —— SAD §13 风险）。
   * 例：'oa-2026-09' = 2026-09 OA 供应商报价核定口径。
   */
  costBasis?: string;
  /**
   * BOM 明细的来源可信度（C7：假数据必须标注）。
   *   'verified'    来自供应商报价单 / 采购单，可逐条追溯
   *   'placeholder' 仅有 unitCost 为实采值，明细是按占比拆分的**占位结构**，
   *                 只能用于"供应商集中度"这类结构性观察，不得用于逐组件核价
   * 缺省视为 'verified'（历史内置数据均来自实采表）。
   */
  bomSource?: 'verified' | 'placeholder';
}

export interface BomLine {
  name: string;
  qty: number;
  unitPrice: number;
  supplier?: string;
  /** 是否属于"小样/试香"类，通常不计入物料成本 */
  isSample?: boolean;
}

/** SKU × 平台 × 日（V10 新增，可缺省） */
export interface SkuDaily {
  date: ISODate;
  platform: Platform;
  sku: string;
  /** 支付件数 */
  qty: number;
  /** 成交均价（不含税或含税沿用平台口径，见 CostPolicy 说明） */
  avgPrice: number;
  refundQty: number;
  refundAmount: number;
  /** 若能拿到单品投流则直连，否则留空走分摊 */
  promotionDirect?: number;
}

/** 推广分摊策略（B5：可配置） */
export type AllocationStrategy =
  | 'direct'     // 有 promotionDirect 时直连
  | 'by-revenue' // 按收入占比（默认）
  | 'by-qty';    // 按销量占比

/** 单品毛利计算的完整结果（compute/skuMargin.ts 的唯一产出形态） */
export interface SkuMargin {
  sku: string;
  platform: Platform;
  qty: number;
  /** 单品收入 = Σ(avgPrice × qty) */
  revenue: number;
  refund: number;
  /** 单品物料成本 = qty × unitCost（真实 BOM，禁止等权） */
  cogs: number;
  /** 平台扣点（按 CostPolicy.platformCommissionRate） */
  commission: number;
  /** 支付手续费 */
  paymentFee: number;
  /** 分摊物流费 = 订单数 × logisticsPerOrder */
  logistics: number;
  /** 推广费（直连或分摊） */
  promotion: number;
  /** 推广费是否为分摊值（C7：true 时前端必须打「分摊」角标） */
  allocated: boolean;
  /** 净利 = revenue − refund − cogs − commission − paymentFee − logistics − promotion */
  net: number;
  /** ROI = revenue / (cogs + promotion)，阈值 ≥1.5 绿 / 1–1.5 橙 / <1 红 */
  roi: number;
  /** 毛利率（仅扣物料），用于与旧版对照 */
  grossMarginRate: number;
  /** 真实毛利率（扣全成本后） */
  netMarginRate: number;
  /**
   * 本条毛利计算所依赖的**近似假设**（人话），界面必须如实展示（C7）。
   * 例：物流费按「一单一瓶」近似；推广费为按收入分摊值。
   */
  assumptions: string[];
}

/**
 * 数据缺口对象 —— SKU 源数据缺失时的**结构化**返回。
 * 刻意不是 `null`，也不是补 0 的假数据：前端据此渲染空态与指引。
 */
export interface DataGap {
  kind: 'data-gap';
  /** 缺什么 */
  scope: 'sku-daily' | 'sku-master' | 'cost-policy';
  /** 人话说明 */
  message: string;
  /** 三步入手指引（PRD B / SAD §6） */
  steps: string[];
}

export function isDataGap(v: unknown): v is DataGap {
  return typeof v === 'object' && v !== null && (v as DataGap).kind === 'data-gap';
}

/** SKU 源数据缺口的标准文案（生意参谋 / 罗盘导出路径） */
export const SKU_DAILY_GAP: DataGap = {
  kind: 'data-gap',
  scope: 'sku-daily',
  message: '尚未导入「商品 × 平台 × 日」的支付件数与成交均价，无法计算单品真实毛利。',
  steps: [
    '打开 淘宝生意参谋 → 商品 → 商品效果，导出「商品 × 日」明细（含支付件数、支付金额）',
    '打开 抖音电商罗盘 → 商品分析，导出同结构明细',
    '把两份文件放进 data/raw/，运行 `npm run origo -- ingest <文件>`，本页将自动填充',
  ],
};

export const SKU_MASTER_GAP: DataGap = {
  kind: 'data-gap',
  scope: 'sku-master',
  message: '缺少 SKU 主数据（BOM 成本 / 售价 / 状态）。',
  steps: [
    '确认 data/master/sku-bom.json 存在且包含 7 款 SKU',
    '核对每款 unitCost 为 OA 供应商报价核定值（含包装）',
    '运行 `npm run origo -- build` 重新生成快照',
  ],
};

export const COST_POLICY_GAP: DataGap = {
  kind: 'data-gap',
  scope: 'cost-policy',
  message: '缺少平台扣点率 / 支付手续费率 / 物流单价，全成本口径不完整。',
  steps: [
    '填写 data/master/platform-fees.json（各平台扣点率、支付费率、物流单价）',
    '缺失的项目会以 0 参与计算，并在界面标注「未计入」',
    '拿到真值后更新该文件即可，无需改代码',
  ],
};
