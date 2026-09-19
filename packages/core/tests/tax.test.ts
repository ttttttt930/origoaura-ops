import { describe, expect, it } from 'vitest';
import {
  computeCit,
  computeDividend,
  computeStampDuty,
  computeSurtax,
  computeTaxScenario,
  computeVat,
  dividendScenarios,
  inputRates,
  stampDutyEffectiveRate,
  surtaxCombinedRate,
} from '../src/index.ts';
import { taxParams } from './fixtures/dataset.ts';

const P = taxParams();
const MONTH = { kind: 'month' as const, start: '2026-09-01', end: '2026-09-30' };

describe('增值税', () => {
  it('一般纳税人：销项 − 进项，且进项按科目分档抵扣', () => {
    const r = computeVat({
      revenue: 100_000,
      refund: 0,
      costs: { material: 30_000, logistics: 5_000, promotion: 20_000 },
      params: P,
      taxpayer: 'general',
      period: MONTH,
    });
    expect(r.netRevenue).toBeCloseTo(88_495.58, 2);
    expect(r.output).toBeCloseTo(11_504.43, 2);
    // 物料 13% / 物流 9% / 推广 6%
    expect(r.input).toBeCloseTo(3_451.33 + 412.84 + 1_132.08, 1);
    expect(r.payable).toBeCloseTo(6_508.18, 1);
    expect(r.carryoverOut).toBe(0);
    expect(r.effectiveRate).toBeGreaterThan(0);
    expect(r.detail.length).toBeGreaterThan(4);
  });

  it('进项大于销项时不退税，结转为留抵', () => {
    const r = computeVat({
      revenue: 10_000,
      refund: 0,
      costs: { material: 50_000 },
      params: P,
      taxpayer: 'general',
      period: MONTH,
    });
    expect(r.payable).toBe(0);
    expect(r.carryoverOut).toBeGreaterThan(0);
  });

  it('上期留抵可继续抵扣', () => {
    const base = {
      revenue: 100_000,
      refund: 0,
      costs: { material: 30_000 },
      params: P,
      taxpayer: 'general' as const,
      period: MONTH,
    };
    const noCarry = computeVat(base);
    const withCarry = computeVat({ ...base, carryoverCredit: 1_000 });
    expect(withCarry.payable).toBeCloseTo(noCarry.payable - 1_000, 1);
  });

  it('小规模：1% 征收率，且月销售额未超 10 万免征', () => {
    const exempt = computeVat({
      revenue: 50_000,
      refund: 0,
      costs: {},
      params: P,
      taxpayer: 'small',
      period: MONTH,
    });
    expect(exempt.exempt).toBe(true);
    expect(exempt.payable).toBe(0);
    expect(exempt.exemptReason).toContain('免征');

    const taxable = computeVat({
      revenue: 150_000,
      refund: 0,
      costs: {},
      params: P,
      taxpayer: 'small',
      period: MONTH,
    });
    expect(taxable.exempt).toBe(false);
    expect(taxable.payable).toBeCloseTo(1_485.15, 1);
  });

  it('退款冲减销售额', () => {
    const withRefund = computeVat({
      revenue: 100_000,
      refund: 20_000,
      costs: {},
      params: P,
      taxpayer: 'general',
      period: MONTH,
    });
    expect(withRefund.netRevenue).toBeCloseTo(80_000 / 1.13, 1);
  });

  it('inputRates 覆盖全部费用科目', () => {
    const rates = inputRates(P);
    expect(rates.material).toBe(0.13);
    expect(rates.logistics).toBe(0.09);
    expect(rates.nonDeductible).toBe(0);
  });
});

describe('附加税费与印花税', () => {
  it('附加税以实缴增值税为基数，不是以收入为基数', () => {
    const r = computeSurtax(1_000, P);
    expect(surtaxCombinedRate(P)).toBeCloseTo(0.06, 6);
    expect(r.amount).toBeCloseTo(60, 2);
    expect(r.halved).toBe(true);
    expect(r.detail[0]!.value).toContain('1,000');
  });

  it('增值税为 0 时附加税为 0（负数也不会倒挂）', () => {
    expect(computeSurtax(0, P).amount).toBe(0);
    expect(computeSurtax(-500, P).amount).toBe(0);
  });

  it('印花税按购销合同额，减半后为万分之 1.5', () => {
    expect(stampDutyEffectiveRate(P)).toBeCloseTo(0.00015, 8);
    const r = computeStampDuty(100_000, 30_000, P);
    expect(r.amount).toBeCloseTo(19.5, 2);
  });
});

describe('企业所得税与分红', () => {
  it('小微 5%，超门槛 25%，亏损 0', () => {
    expect(computeCit({ preTaxProfit: 100_000, params: P }).amount).toBeCloseTo(5_000, 2);
    expect(computeCit({ preTaxProfit: 100_000, params: P }).basis).toBe('small-micro');
    const big = computeCit({ preTaxProfit: 4_000_000, params: P });
    expect(big.basis).toBe('statutory');
    expect(big.amount).toBeCloseTo(1_000_000, 2);
    expect(computeCit({ preTaxProfit: -50_000, params: P }).amount).toBe(0);
  });

  it('纳税调增 / 调减参与计算', () => {
    const r = computeCit({ preTaxProfit: 100_000, params: P, addBack: 20_000, deduction: 10_000 });
    expect(r.taxableIncome).toBeCloseTo(110_000, 2);
  });

  it('分红个税 20%，三档情景', () => {
    expect(computeDividend(100_000, P, 1).tax).toBeCloseTo(20_000, 2);
    expect(computeDividend(100_000, P, 1).netToShareholder).toBeCloseTo(80_000, 2);
    const three = dividendScenarios(100_000, P);
    expect(three.map((d) => d.tax)).toEqual([0, 10_000, 20_000]);
  });
});

describe('税务全链路（修正 V9 的三个口径错误）', () => {
  const scenario = computeTaxScenario({
    revenue: 100_000,
    refund: 0,
    costs: { material: 30_000, logistics: 5_000, promotion: 20_000 },
    taxpayer: 'general',
    params: P,
    period: MONTH,
  });

  it('增值税是价外税，不进入损益表', () => {
    // 利润总额 = 不含税收入 − 不含税成本 − 税金及附加（**不减增值税**）
    expect(scenario.preTaxProfit).toBeCloseTo(
      scenario.netRevenue - scenario.netCosts - scenario.surchargeAndStamp,
      2,
    );
    expect(scenario.preTaxProfit).not.toBeCloseTo(
      scenario.netRevenue - scenario.netCosts - scenario.surchargeAndStamp - scenario.vat.payable,
      0,
    );
    expect(scenario.waterfall.some((w) => w.step.includes('增值税'))).toBe(false);
    expect(scenario.notes.join('')).toContain('价外税');
  });

  it('损益类税金 = 附加税费 + 印花税', () => {
    expect(scenario.surchargeAndStamp).toBeCloseTo(
      scenario.surtax.amount + scenario.stamp.amount,
      2,
    );
  });

  it('净利润 = 利润总额 − 所得税；税负含分红个税', () => {
    expect(scenario.netProfit).toBeCloseTo(scenario.preTaxProfit - scenario.cit.amount, 2);
    expect(scenario.totalTaxBurden).toBeCloseTo(
      scenario.vat.payable + scenario.surchargeAndStamp + scenario.cit.amount + scenario.dividend.tax,
      2,
    );
    expect(scenario.taxBurdenRate).toBeGreaterThan(0);
  });

  it('瀑布图是纯增量账本：逐笔累加应等于利润总额，末行是净利润', () => {
    let run = 0;
    for (const w of scenario.waterfall) {
      run += w.value;
      // 小计行不是增量，其 cumulative 才是余额；两条路径必须一致
      expect(run).toBeCloseTo(w.cumulative, 1);
      if (w.step === '利润总额') {
        expect(w.subtotal).toBe(true);
        expect(w.cumulative).toBeCloseTo(scenario.preTaxProfit, 1);
      }
      if (w.step === '净利润') {
        expect(w.subtotal).toBe(true);
        expect(w.cumulative).toBeCloseTo(scenario.netProfit, 1);
      }
    }
    // 起点是不含税收入；含税 GMV 不得进入账本（否则同一笔钱会被算两次）
    expect(scenario.waterfall[0]!.step).toBe('不含税收入');
    expect(scenario.waterfall[0]!.value).toBeCloseTo(scenario.netRevenue, 2);
    expect(scenario.waterfall.some((w) => w.step.includes('GMV'))).toBe(false);
    expect(scenario.waterfall[scenario.waterfall.length - 1]!.step).toBe('净利润');
  });

  it('未取数的科目必须显式声明未计入（C7）', () => {
    expect(scenario.notes.some((n) => n.includes('灌装') || n.includes('未包含'))).toBe(true);
  });

  it('小规模纳税人走免征档时税负显著更低', () => {
    const small = computeTaxScenario({
      revenue: 80_000,
      refund: 0,
      costs: { material: 20_000, promotion: 10_000 },
      taxpayer: 'small',
      params: P,
      period: MONTH,
      payoutRatio: 0,
    });
    expect(small.vat.exempt).toBe(true);
    expect(small.totalTaxBurden).toBeLessThan(scenario.totalTaxBurden);
  });
});
