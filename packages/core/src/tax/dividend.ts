/**
 * L5 · tax/dividend —— 股东分红个人所得税（20%）
 *
 * 只对**税后净利润中实际分配**的部分计征；未分配利润不分红不缴。
 * 场景测算里应同时给出"全分红 / 部分分红 / 不分红"三档，避免用户误以为
 * 净利润到手的钱就是账面净利润。
 */

import type { TaxParams } from '../model/finance.ts';

export interface DividendResult {
  /** 可分配利润（一般等于税后净利润，扣除法定盈余公积后的口径由财务调整） */
  distributable: number;
  /** 实际分红金额 */
  dividend: number;
  /** 分红个税 */
  tax: number;
  /** 税后到手 */
  netToShareholder: number;
  detail: { step: string; value: string }[];
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * @param netProfit   税后净利润
 * @param payoutRatio 分红比例 0–1（默认 1 = 全额分红）
 */
export function computeDividend(
  netProfit: number,
  params: TaxParams,
  payoutRatio = 1,
): DividendResult {
  const ratio = Math.min(1, Math.max(0, payoutRatio));
  const distributable = round2(Math.max(0, netProfit));
  const dividend = round2(distributable * ratio);
  const tax = round2(dividend * params.dividendTaxRate);
  return {
    distributable,
    dividend,
    tax,
    netToShareholder: round2(dividend - tax),
    detail: [
      { step: '可分配利润', value: `¥${distributable}` },
      { step: '分红比例', value: `${round2(ratio * 100)}%` },
      { step: '分红金额', value: `¥${dividend}` },
      { step: `分红个税（${round2(params.dividendTaxRate * 100)}%）`, value: `¥${tax}` },
      { step: '股东到手', value: `¥${round2(dividend - tax)}` },
    ],
  };
}
