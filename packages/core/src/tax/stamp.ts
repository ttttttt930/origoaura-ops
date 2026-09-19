/**
 * L5 · tax/stamp —— 印花税（购销合同，万分之三，六税两费可减半）
 *
 * 计税依据 = 销售收入 + 采购金额（购销合同金额），**不含税**口径优先。
 * 国内电商实务中经常按含税金额申报，故这里同时给出两种口径供财务选择，
 * 默认取不含税（更保守合规），并留痕。
 */

import type { TaxParams } from '../model/finance.ts';
import { stampDutyEffectiveRate } from '../model/finance.ts';

export interface StampDutyResult {
  salesBase: number;
  purchaseBase: number;
  rate: number;
  amount: number;
  halved: boolean;
  detail: { step: string; value: string }[];
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export function computeStampDuty(
  netRevenue: number,
  purchaseAmount: number,
  params: TaxParams,
): StampDutyResult {
  const rate = stampDutyEffectiveRate(params);
  const salesBase = round2(Math.max(0, netRevenue));
  const purchaseBase = round2(Math.max(0, purchaseAmount));
  const amount = round2((salesBase + purchaseBase) * rate);
  return {
    salesBase,
    purchaseBase,
    rate,
    amount,
    halved: params.stampDutyHalved,
    detail: [
      { step: '销售合同金额（不含税）', value: `¥${salesBase}` },
      { step: '采购合同金额（不含税）', value: `¥${purchaseBase}` },
      {
        step: '适用税率',
        value: `万分之${round2(rate * 10000)}${params.stampDutyHalved ? '（六税两费减半）' : ''}`,
      },
      { step: '印花税合计', value: `¥${amount}` },
    ],
  };
}
