/**
 * L5 · tax/scenario —— 税务全链路测算（PRD F2/F3，迁移并修正 V7–V9 scCalc）
 *
 * 链路（严格按会计口径，增值税不进损益表）：
 *   含税 GMV
 *     → 减：退款                     = 含税净销售
 *     → 价税分离                     = 不含税收入
 *     → 减：不含税成本/费用（物料、物流、推广、佣金、手续费、其他）
 *     → 减：税金及附加（附加税费 + 印花税）   ← 这两项才是损益类税金
 *     → 利润总额
 *     → 减：企业所得税
 *     → 净利润
 *     → （可选）分红个税
 *     → 股东到手
 *
 * V9 的错误：把增值税也当成损益减项、附加税以收入为基数、分红个税漏算，
 * 三者叠加导致"税后净利"被系统性低估。以上全部在本文件修正。
 */

import type { TaxParams } from '../model/finance.ts';
import type { CostBreakdown, TaxInput, TaxpayerType, VatResult } from './types.ts';
import { computeVat } from './vat.ts';
import { computeSurtax, type SurtaxResult } from './surtax.ts';
import { computeStampDuty, type StampDutyResult } from './stamp.ts';
import { computeCit, type CitResult } from './cit.ts';
import { computeDividend, type DividendResult } from './dividend.ts';

export interface TaxScenarioInput {
  /** 含税销售额 GMV */
  revenue: number;
  /** 含税退款 */
  refund: number;
  /** 各科目**含税**金额 */
  costs: CostBreakdown;
  /** 采购金额（含税），用于印花税；不传则取 costs.material */
  purchaseAmount?: number;
  taxpayer: TaxpayerType;
  params: TaxParams;
  period: TaxInput['period'];
  /** 分红比例 0–1，默认 1 */
  payoutRatio?: number;
  /** 上期留抵税额 */
  carryoverCredit?: number;
}

/**
 * 瀑布图的一步。
 *
 * 刻意区分「增减行」与「小计行」：小计行的 value 恒为 0，只呈现当前余额。
 * 若把利润总额当作一个正的增量行，逐笔累加就会把它算两遍（V9 的瀑布图正是这样对不上的）。
 * 前端渲染直接用 `cumulative`，不需要自己维护累加状态。
 */
export interface WaterfallStep {
  step: string;
  /** 本步增减额；小计行恒为 0 */
  value: number;
  /** 该步之后的累计余额 */
  cumulative: number;
  /** 是否小计行（利润总额 / 净利润） */
  subtotal: boolean;
  kind: 'revenue' | 'cost' | 'tax' | 'profit';
}

export interface TaxScenarioResult {
  /** 含税净销售 = revenue − refund */
  grossRevenue: number;
  /** 不含税收入 */
  netRevenue: number;
  /** 不含税成本费用合计 */
  netCosts: number;
  /** 损益类税金（附加税费 + 印花税） */
  surchargeAndStamp: number;
  /** 利润总额 */
  preTaxProfit: number;
  /** 税后净利润 */
  netProfit: number;
  /** 综合税负（所有税 / 含税净销售） */
  totalTaxBurden: number;
  /** 综合税负率 */
  taxBurdenRate: number;
  vat: VatResult;
  surtax: SurtaxResult;
  stamp: StampDutyResult;
  cit: CitResult;
  dividend: DividendResult;
  /** 成本结构（不含税），用于瀑布图 */
  costBreakdown: { key: keyof CostBreakdown; label: string; amount: number }[];
  /** 分步明细，财务页直接渲染（已带累计余额，前端无需自己累加） */
  waterfall: WaterfallStep[];
  /** 计算前提与未计入项（C7） */
  notes: string[];
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

const COST_LABEL: Record<keyof CostBreakdown, string> = {
  material: '物料采购',
  logistics: '物流快递',
  promotion: '推广投流',
  anchorService: '达人服务费',
  commission: '平台佣金',
  paymentFee: '支付手续费',
  nonDeductible: '其他无票支出',
};

/** 含税 → 不含税（按该科目的抵扣率反算） */
function toNet(amount: number, rate: number): number {
  return round2(amount / (1 + rate));
}

export function computeTaxScenario(input: TaxScenarioInput): TaxScenarioResult {
  const { params, taxpayer, costs, refund } = input;

  // ---- 1) 增值税 ----
  const vat = computeVat({
    revenue: input.revenue,
    refund,
    costs,
    params,
    taxpayer,
    period: input.period,
    carryoverCredit: input.carryoverCredit,
  });

  const grossRevenue = round2(Math.max(0, input.revenue - refund));
  const netRevenue = vat.netRevenue;

  // ---- 2) 成本费用价税分离 ----
  const vatInputRates: Record<keyof CostBreakdown, number> = {
    material: params.inputRateMaterial,
    logistics: params.inputRateLogistics,
    promotion: params.inputRatePromotion,
    anchorService: params.inputRateAnchor,
    commission: params.inputRatePromotion,
    paymentFee: params.inputRatePromotion,
    nonDeductible: 0,
  };
  const costBreakdown = (Object.keys(COST_LABEL) as (keyof CostBreakdown)[])
    .map((key) => ({
      key,
      label: COST_LABEL[key],
      amount: toNet(costs[key] ?? 0, vatInputRates[key]),
    }))
    .filter((c) => c.amount !== 0);
  const netCosts = round2(costBreakdown.reduce((a, c) => a + c.amount, 0));

  // ---- 3) 税金及附加（附加税费 + 印花税）----
  const surtax = computeSurtax(vat.payable, params);
  const stamp = computeStampDuty(netRevenue, input.purchaseAmount ?? costs.material ?? 0, params);
  const surchargeAndStamp = round2(surtax.amount + stamp.amount);

  // ---- 4) 利润总额 ----
  const preTaxProfit = round2(netRevenue - netCosts - surchargeAndStamp);

  // ---- 5) 企业所得税 ----
  const cit = computeCit({ preTaxProfit, params });
  const netProfit = round2(preTaxProfit - cit.amount);

  // ---- 6) 分红 ----
  const dividend = computeDividend(netProfit, params, input.payoutRatio ?? 1);

  // ---- 7) 税负 ----
  const totalTaxBurden = round2(vat.payable + surchargeAndStamp + cit.amount + dividend.tax);

  /**
   * 瀑布图 = **纯增量账本**，从「不含税收入」逐笔减到「净利润」。
   * 刻意不把「含税 GMV」放进账本 —— 它会与「不含税收入」形成同一笔钱的两行，
   * 直接累加就会重复计数（V9 的瀑布图正是这样对不上的）。
   * 含税口径单独放在 `grossRevenue`。
   */
  const waterfall: WaterfallStep[] = [];
  let balance = 0;
  const push = (step: string, value: number, kind: WaterfallStep['kind'], subtotal = false): void => {
    balance = round2(balance + value);
    waterfall.push({ step, value, cumulative: balance, subtotal, kind });
  };

  push('不含税收入', netRevenue, 'revenue');
  for (const c of costBreakdown) push(c.label, -c.amount, 'cost');
  push('附加税费', -surtax.amount, 'tax');
  push('印花税', -stamp.amount, 'tax');
  push('利润总额', 0, 'profit', true);
  push('企业所得税', -cit.amount, 'tax');
  push('净利润', 0, 'profit', true);

  const notes: string[] = [];
  notes.push(
    `纳税人身份：${taxpayer === 'general' ? '一般纳税人（销项 13%，进项按科目抵扣）' : '小规模纳税人（征收率 1%）'}`,
  );
  if (vat.carryoverOut > 0) notes.push(`本期进项大于销项，留抵 ¥${vat.carryoverOut} 结转下期（增值税不退税）`);
  if (vat.exempt) notes.push(vat.exemptReason ?? '本期免征增值税');
  notes.push('增值税为价外税，不进入损益表；损益类税金仅含附加税费与印花税，这是与旧版最大的口径差异。');
  notes.push('瀑布图以「不含税收入」为起点，是纯增量账本，可直接逐笔累加校验。');
  notes.push('灌装 / 人工 / 包材损耗 / 折旧摊销等科目尚未取数，成本费用合计未包含，实际净利会低于本测算。');
  if (dividend.tax > 0) notes.push(`按 ${Math.round((input.payoutRatio ?? 1) * 100)}% 分红比例测算，分红个税 ¥${dividend.tax}`);

  return {
    grossRevenue,
    netRevenue,
    netCosts,
    surchargeAndStamp,
    preTaxProfit,
    netProfit,
    totalTaxBurden,
    taxBurdenRate: grossRevenue > 0 ? Math.round((totalTaxBurden / grossRevenue) * 10000) / 100 : 0,
    vat,
    surtax,
    stamp,
    cit,
    dividend,
    costBreakdown,
    waterfall,
    notes,
  };
}

/**
 * 三档分红情景对比（不分红 / 半分红 / 全分红），供"到手现金"决策。
 */
export function dividendScenarios(netProfit: number, params: TaxParams): TaxScenarioResult['dividend'][] {
  return [0, 0.5, 1].map((r) => computeDividend(netProfit, params, r));
}
