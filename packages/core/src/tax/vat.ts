/**
 * L5 · tax/vat —— 增值税（销项 − 进项，留抵结转）
 *
 * 一般纳税人：
 *   销项 = 含税收入 / (1 + 13%) × 13%
 *   进项 = Σ 各类含税成本 / (1 + 对应率) × 对应率
 *   应纳 = max(0, 销项 − 进项 − 上期留抵)；不足抵扣部分结转下期
 *
 * 小规模纳税人：
 *   应纳 = 含税收入 / (1 + 1%) × 1%
 *   月销售额 ≤ 10 万（季 ≤ 30 万）免征（2027-12-31 前政策，参数外置）
 */

import type { CostBreakdown, TaxInput, VatResult } from './types.ts';
import type { TaxParams } from '../model/finance.ts';

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
const pct = (v: number) => `${Math.round(v * 10000) / 100}%`;

/** 各科目 → 进项抵扣率 */
export function inputRates(p: TaxParams): Record<keyof CostBreakdown, number> {
  return {
    material: p.inputRateMaterial,
    logistics: p.inputRateLogistics,
    promotion: p.inputRatePromotion,
    anchorService: p.inputRateAnchor,
    commission: p.inputRatePromotion,
    paymentFee: p.inputRatePromotion,
    nonDeductible: 0,
  };
}

export function computeVat(input: TaxInput): VatResult {
  const { revenue, refund, costs, params, taxpayer } = input;
  const detail: VatResult['detail'] = [];
  // 退货冲减销售额
  const grossRevenue = Math.max(0, round2(revenue - refund));

  if (taxpayer === 'small') {
    const r = params.vatSmallRateActual;
    const netRevenue = round2(grossRevenue / (1 + r));
    const output = round2(netRevenue * r);

    const isMonthly = input.period.kind === 'month';
    const isQuarterly = input.period.kind === 'quarter';
    const threshold = isMonthly
      ? params.smallExemptMonthly
      : isQuarterly
        ? params.smallExemptQuarterly
        : params.smallExemptQuarterly * 4;
    const exempt = (isMonthly || isQuarterly) && grossRevenue <= threshold;

    detail.push({ step: '不含税销售额', value: `¥${netRevenue}` });
    detail.push({ step: `征收率（小规模）`, value: pct(r) });
    detail.push({ step: '销项税额', value: `¥${output}` });
    detail.push({
      step: '免征额判定',
      value: `${input.period.kind === 'month' ? '月' : input.period.kind === 'quarter' ? '季' : '年'}销售额 ¥${grossRevenue} ${exempt ? '≤' : '>'} ¥${threshold}`,
    });

    return {
      netRevenue,
      output,
      input: 0,
      exempt,
      exemptReason: exempt ? `小规模纳税人销售额未超免征额（¥${threshold}），本期免征增值税。` : undefined,
      payable: exempt ? 0 : output,
      carryoverOut: 0,
      effectiveRate: netRevenue > 0 ? round4((exempt ? 0 : output) / netRevenue) : 0,
      detail,
    };
  }

  // ---- 一般纳税人 ----
  const rate = params.vatGeneralRate;
  const netRevenue = round2(grossRevenue / (1 + rate));
  const output = round2(netRevenue * rate);

  const rates = inputRates(params);
  let inputTotal = 0;
  detail.push({ step: '不含税销售额', value: `¥${netRevenue}` });
  detail.push({ step: `销项税额（${pct(rate)}）`, value: `¥${output}` });
  for (const [key, rateKey] of Object.entries(rates) as [keyof CostBreakdown, number][]) {
    const amount = costs[key] ?? 0;
    if (!amount) continue;
    const inputTax = round2((amount / (1 + rateKey)) * rateKey);
    inputTotal += inputTax;
    detail.push({
      step: `进项 · ${labelOf(key)}`,
      value: `¥${amount} 含税 × ${pct(rateKey)} → ¥${inputTax}`,
    });
  }
  inputTotal = round2(inputTotal);

  const carryover = input.carryoverCredit ?? 0;
  const net = round2(output - inputTotal - carryover);
  const payable = Math.max(0, net);
  const carryoverOut = net < 0 ? round2(-net) : 0;

  detail.push({ step: '可抵扣进项合计', value: `¥${inputTotal}` });
  if (carryover) detail.push({ step: '上期留抵结转', value: `¥${carryover}` });
  detail.push({
    step: '应纳税额',
    value: carryoverOut > 0 ? `¥0（进项大于销项，结转留抵 ¥${carryoverOut}）` : `¥${payable}`,
  });

  return {
    netRevenue,
    output,
    input: inputTotal,
    exempt: false,
    payable,
    carryoverOut,
    effectiveRate: netRevenue > 0 ? round4(payable / netRevenue) : 0,
    detail,
  };
}

function labelOf(key: keyof CostBreakdown): string {
  return {
    material: '物料采购',
    logistics: '物流快递',
    promotion: '推广服务',
    anchorService: '达人服务费',
    commission: '平台佣金',
    paymentFee: '支付手续费',
    nonDeductible: '不可抵扣支出',
  }[key];
}

function round4(v: number): number {
  return Math.round((v + Number.EPSILON) * 10000) / 10000;
}
