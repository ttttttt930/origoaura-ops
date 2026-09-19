/**
 * L5 · tax/cit —— 企业所得税（小型微利 vs 法定 25%）
 *
 * 小型微利企业（2027-12-31 前）：年应纳税所得额 ≤ 300 万部分，实际税负 5%。
 * 超过门槛按法定 25%（严格说是分段，但小微一旦超标通常整体不符合小微条件，
 * 故这里用门槛二选一并在 detail 中说明判定依据，避免给出误导性的分段结果）。
 *
 * 应纳税所得额 = 利润总额 + 纳税调增 − 纳税调减（本项目默认不做调整，参数留位）。
 */

import type { TaxParams } from '../model/finance.ts';

export interface CitInput {
  /** 利润总额（税前） */
  preTaxProfit: number;
  params: TaxParams;
  /** 纳税调增（不可税前扣除项回加），默认 0 */
  addBack?: number;
  /** 纳税调减（加计扣除等），默认 0 */
  deduction?: number;
}

export interface CitResult {
  taxableIncome: number;
  /** 'small-micro' | 'statutory' */
  basis: 'small-micro' | 'statutory';
  rate: number;
  amount: number;
  detail: { step: string; value: string }[];
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export function computeCit(input: CitInput): CitResult {
  const { params, addBack = 0, deduction = 0 } = input;
  const taxableIncome = round2(Math.max(0, input.preTaxProfit + addBack - deduction));
  const isSmall = taxableIncome > 0 && taxableIncome <= params.citSmallMicroThreshold;
  const rate = isSmall ? params.citSmallMicroRate : params.citStatutoryRate;
  const amount = round2(taxableIncome * rate);
  const detail: CitResult['detail'] = [
    { step: '利润总额', value: `¥${round2(input.preTaxProfit)}` },
  ];
  if (addBack) detail.push({ step: '纳税调增', value: `¥${round2(addBack)}` });
  if (deduction) detail.push({ step: '纳税调减', value: `¥${round2(deduction)}` });
  detail.push({ step: '应纳税所得额', value: `¥${taxableIncome}` });
  detail.push({
    step: '适用政策',
    value: isSmall
      ? `小型微利（≤ ¥${params.citSmallMicroThreshold}），实际税负 ${round2(rate * 100)}%`
      : taxableIncome <= 0
        ? '亏损，无应纳税额'
        : `超过小微门槛，适用法定税率 ${round2(rate * 100)}%`,
  });
  detail.push({ step: '企业所得税', value: `¥${amount}` });
  return { taxableIncome, basis: isSmall ? 'small-micro' : 'statutory', rate, amount, detail };
}
