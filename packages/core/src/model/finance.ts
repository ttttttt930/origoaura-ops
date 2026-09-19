/**
 * L5 · model/finance —— 全成本口径与税务参数
 *
 * 两条设计原则（SAD §6 / ADR-09）：
 *  1. 税率 / 扣点 / 物流单价全部**外置为 master 数据**，政策变动只改数据不改代码；
 *  2. 尚未拿到真值的科目（灌装 / 人工 / 损耗 / 折旧）**预留字段但缺省 0**，
 *     界面必须显式标注「未计入」，不得静默按 0 参与决策（C7）。
 */

import type { Platform } from './daily.ts';

/** 全成本口径（PRD F1） */
export interface CostPolicy {
  /** 各平台佣金/扣点率，如 0.05 = 5% */
  platformCommissionRate: Record<Platform, number>;
  /** 支付手续费率，如 0.006 */
  paymentFeeRate: number;
  /** 物流快递费单价（元/单） */
  logisticsPerOrder: number;

  // ---- V10 预留字段：缺省 0，界面标注「未计入」（PRD F1 / ADR-09）----
  /** 灌装成本（元/瓶），V10 未计入 */
  fillingPerUnit: number;
  /** 人工成本（元/瓶），V10 未计入 */
  laborPerUnit: number;
  /** 包材损耗率，V10 未计入 */
  packagingLossRate: number;

  /** 口径说明，用于界面「未计入」提示与文档留痕 */
  note: string;
}

/**
 * 已拿到真值、参与计算的科目（界面展示"已计入"的口径清单）。
 * 刻意从 CostPolicy 实际取值推导，而不是写死一份常量 ——
 * 否则新增科目时忘了同步这里，界面就会把"已计入"说成"未计入"。
 */
export function activeCostKeys(p: CostPolicy): string[] {
  const keys: string[] = [];
  if (p.platformCommissionRate && Object.keys(p.platformCommissionRate).length) keys.push('平台扣点');
  if (p.paymentFeeRate) keys.push('支付手续费');
  if (p.logisticsPerOrder) keys.push('物流单价');
  if (p.fillingPerUnit) keys.push('灌装');
  if (p.laborPerUnit) keys.push('人工');
  if (p.packagingLossRate) keys.push('包材损耗');
  return keys;
}

/** 缺省 0、界面需标注「未计入」的科目 */
export function excludedCostKeys(p: CostPolicy): string[] {
  const excluded: string[] = [];
  if (!p.fillingPerUnit) excluded.push('灌装');
  if (!p.laborPerUnit) excluded.push('人工');
  if (!p.packagingLossRate) excluded.push('包材损耗');
  return excluded;
}

/** 税务参数（data/master/tax-rates.json）—— 2026 现行有效值 */
export interface TaxParams {
  /** 政策有效期（界面展示用） */
  policyValidUntil: string;

  // ---- 增值税 ----
  /** 一般纳税人销售货物税率 */
  vatGeneralRate: number;          // 0.13
  /** 小规模征收率（法定） */
  vatSmallRateNominal: number;     // 0.03
  /** 小规模减按征收率 */
  vatSmallRateActual: number;      // 0.01
  /** 小规模月免征额（元） */
  smallExemptMonthly: number;      // 100000
  /** 小规模季免征额（元） */
  smallExemptQuarterly: number;    // 300000

  // ---- 进项抵扣率（按费用类型） ----
  inputRateMaterial: number;       // 0.13
  inputRateLogistics: number;      // 0.09
  inputRatePromotion: number;      // 0.06
  inputRateAnchor: number;         // 0.06 主播服务费

  // ---- 附加税费 ----
  surtaxCityRate: number;          // 0.07 城建税（市区）
  surtaxEduRate: number;           // 0.03 教育费附加
  surtaxLocalEduRate: number;      // 0.02 地方教育附加
  /** 六税两费减半（小微/个体），true 时附加综合税率减半 */
  surtaxHalved: boolean;

  // ---- 印花税 ----
  /** 购销合同印花税率（万分之三） */
  stampDutyRate: number;           // 0.0003
  /** 印花税是否减半（六税两费） */
  stampDutyHalved: boolean;

  // ---- 企业所得税 ----
  /** 小型微利实际税负 */
  citSmallMicroRate: number;       // 0.05
  /** 法定税率 */
  citStatutoryRate: number;        // 0.25
  /** 小型微利判定门槛 */
  citSmallMicroThreshold: number;  // 3000000

  // ---- 分红 ----
  /** 股东分红个人所得税率 */
  dividendTaxRate: number;         // 0.20
}

/** 附加税费综合率（含减半） */
export function surtaxCombinedRate(p: TaxParams): number {
  const base = p.surtaxCityRate + p.surtaxEduRate + p.surtaxLocalEduRate; // 0.12
  return p.surtaxHalved ? base / 2 : base;                                // 0.06
}

/** 印花税实际率（含减半）：0.0003 / 2 = 万 1.5 */
export function stampDutyEffectiveRate(p: TaxParams): number {
  return p.stampDutyHalved ? p.stampDutyRate / 2 : p.stampDutyRate;
}
