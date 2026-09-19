/**
 * L5 · tax/surtax —— 附加税费（城建税 + 教育费附加 + 地方教育附加）
 *
 * 计征依据是**实际缴纳的增值税**，不是收入 —— V8 曾把它写成按收入计，
 * 导致附加税费被高估一个数量级。此处以 vatPayable 为唯一基数。
 *
 * 六税两费减半时，综合率由 12% 降为 6%（参数外置）。
 */

import type { TaxParams } from '../model/finance.ts';
import { surtaxCombinedRate } from '../model/finance.ts';
import { formatMoney } from '../model/format.ts';

export interface SurtaxResult {
  base: number;
  rate: number;
  amount: number;
  halved: boolean;
  detail: { step: string; value: string }[];
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export function computeSurtax(vatPayable: number, params: TaxParams): SurtaxResult {
  const rate = surtaxCombinedRate(params);
  const amount = round2(Math.max(0, vatPayable) * rate);
  const detail = [
    {
      step: '计税依据（实缴增值税）',
      value: formatMoney(round2(Math.max(0, vatPayable))),
    },
    {
      step: '综合附加税率',
      value: `${round2(rate * 100)}%（城建 ${round2(params.surtaxCityRate * 100)}% + 教育 ${round2(params.surtaxEduRate * 100)}% + 地方教育 ${round2(params.surtaxLocalEduRate * 100)}%${params.surtaxHalved ? '，已享六税两费减半' : ''}）`,
    },
    { step: '附加税费合计', value: formatMoney(amount) },
  ];
  return { base: round2(Math.max(0, vatPayable)), rate, amount, halved: params.surtaxHalved, detail };
}
