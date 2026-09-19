/**
 * 真实数据回归（golden 税务场景）
 *
 * 夹具：zip 中的 `scenarios-24.json` —— 24 组（客单价 × 达人分成 × ROI × GMV）参数矩阵，
 * 每组给出小规模纳税人 S 与一般纳税人 G 两套税金结果。
 *
 * ⚠️ 对账结论（见 fixtures/golden/README.md）：
 *   ✅ 可锁定层：**不含税收入（价税分离）** 48/48 完全一致 → 本文件只断言这一层。
 *   ❌ 不可锁定层：附加税费（对方按增值税 7.5%，我方按六税两费减半 6% + 印花税）、
 *      企业所得税（对方不执行小型微利 300 万门槛，我方执行）、进项抵扣率分科目口径。
 *      这三项属于**政策参数差异**，不是计算错误，故不作为回归基线，
 *      强行断言只会把对方的参数错误固化进我们的门禁。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeTaxScenario } from '../src/tax/scenario.ts';
import type { CostBreakdown, TaxpayerType } from '../src/tax/types.ts';
import type { TaxParams } from '../src/model/finance.ts';

/** 与 data/master/tax-rates.json 一致（内核测试不读文件） */
const PARAMS: TaxParams = {
  policyValidUntil: '2027-12-31',
  vatGeneralRate: 0.13,
  vatSmallRateNominal: 0.03,
  vatSmallRateActual: 0.01,
  smallExemptMonthly: 100000,
  smallExemptQuarterly: 300000,
  inputRateMaterial: 0.13,
  inputRateLogistics: 0.09,
  inputRatePromotion: 0.06,
  inputRateAnchor: 0.06,
  surtaxCityRate: 0.07,
  surtaxEduRate: 0.03,
  surtaxLocalEduRate: 0.02,
  surtaxHalved: true,
  stampDutyRate: 0.0003,
  stampDutyHalved: true,
  citSmallMicroRate: 0.05,
  citStatutoryRate: 0.25,
  citSmallMicroThreshold: 3000000,
  dividendTaxRate: 0.2,
  generalRegThreshold: 5_000_000,
  thresholdWarnRatio: 0.8,
  latePenaltyDailyRate: 0.0005,
};

interface GoldenCase {
  gmv: number;
  cogs: number;
  logi: number;
  ad: number;
  talent: number;
  S: { sales: number };
  G: { sales: number };
}

const CASES = JSON.parse(
  readFileSync(new URL('./fixtures/golden/scenarios-24.json', import.meta.url), 'utf8'),
) as GoldenCase[];

describe('golden 税务场景 · 价税分离回归', () => {
  it('夹具为 24 组场景', () => {
    expect(CASES).toHaveLength(24);
  });

  it.each([['S', 'small'], ['G', 'general']] as const)(
    '纳税人 %s：不含税收入 24/24 与 golden 一致',
    (side, taxpayer) => {
      for (const c of CASES) {
        const costs: CostBreakdown = {
          material: c.cogs,
          logistics: c.logi,
          promotion: c.ad,
          anchorService: c.talent,
          commission: 0,
          paymentFee: 0,
          nonDeductible: 0,
        };
        const r = computeTaxScenario({
          revenue: c.gmv,
          refund: 0,
          costs,
          taxpayer: taxpayer as TaxpayerType,
          params: PARAMS,
          period: 'month',
        });
        // 容差 ¥0.01：双方都在做四舍五入，允许末位 1 分
        expect(Math.abs(r.netRevenue - c[side].sales)).toBeLessThan(0.02);
      }
    },
  );

  it('一般纳税人不含税收入 = 含税 GMV ÷ 1.13（价外税不入损益）', () => {
    const c = CASES[0]!;
    expect(c.G.sales).toBeCloseTo(c.gmv / 1.13, 2);
  });
});
