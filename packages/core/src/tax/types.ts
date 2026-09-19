/**
 * L5 · tax —— 税务计算公共类型
 *
 * V10 相对 V7–V9 的关键改动：
 *   1. 税率全部外置到 data/master/tax-rates.json（ADR-09），代码里不留魔法数；
 *   2. 每个科目返回**可追溯的中间量**（销项/进项/留抵），而不是只给一个结果数；
 *   3. 留抵税额处理明确：当期进项 > 销项时不退税、结转为 0 应纳（并给出结转额提示）。
 */

import type { TaxParams } from '../model/finance.ts';

/** 纳税人身份 */
export type TaxpayerType =
  | 'general'   // 一般纳税人（13% 销项，可抵扣进项）
  | 'small';    // 小规模纳税人（1% 征收率，享免征额）

/** 费用科目（用于进项抵扣分档） */
export interface CostBreakdown {
  /** 物料采购（含包装），进项 13% */
  material: number;
  /** 物流快递，进项 9% */
  logistics: number;
  /** 推广/广告服务，进项 6% */
  promotion: number;
  /** 主播/达人服务费，进项 6% */
  anchorService?: number;
  /** 平台佣金（平台开票 6%） */
  commission?: number;
  /** 支付手续费（支付机构开票 6%） */
  paymentFee?: number;
  /** 其他无票/不可抵扣支出 */
  nonDeductible?: number;
}

export interface TaxInput {
  /** 含税销售额（GMV） */
  revenue: number;
  /** 含税退款 */
  refund: number;
  /** 期间长度，用于小规模免征额判定（月 / 季） */
  period: { kind: 'month' | 'quarter' | 'year'; start: string; end: string };
  taxpayer: TaxpayerType;
  costs: CostBreakdown;
  params: TaxParams;
  /**
   * 上期留抵税额（进项大于销项的结余），默认 0。
   * 增值税不退税，只结转，故这里显式建模。
   */
  carryoverCredit?: number;
}

/** 增值税计算结果 */
export interface VatResult {
  /** 含税 -> 不含税销售额 */
  netRevenue: number;
  /** 销项税额 */
  output: number;
  /** 可抵扣进项税额 */
  input: number;
  /** 是否触发小规模免征（当期免税） */
  exempt: boolean;
  /** 免税/免征原因 */
  exemptReason?: string;
  /** 应纳税额（≥0） */
  payable: number;
  /** 留下的结转进项（本期进项未抵完部分） */
  carryoverOut: number;
  /** 有效税率（应纳税额 / 不含税收入），用于横向对比 */
  effectiveRate: number;
  /** 计算过程留痕（界面"税务计算说明"直接渲染） */
  detail: { step: string; value: string }[];
}
