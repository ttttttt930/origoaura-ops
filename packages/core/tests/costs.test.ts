import { describe, expect, it } from 'vitest';
import { buildWindow, deriveCosts, toCostBreakdown } from '../src/index.ts';
import {
  buildDay,
  costPolicy,
  skuDailyRecords,
  skuMaster,
  SKU_MASTER_BASELINE,
  TODAY,
} from './fixtures/dataset.ts';

describe('费用科目分解（税务申报口径）', () => {
  it('单平台单日：佣金 / 手续费 / 物流 / 推广 逐项手算校验', () => {
    const daily = buildDay('2026-09-10', { taobao: [1000, 0, 200, 10] });
    const w = buildWindow('today', daily, '2026-09-10');
    const c = deriveCosts({ daily, window: w, skuMaster: skuMaster(), costPolicy: costPolicy() });

    expect(c.commission).toBe(50); // 1000 × 5%
    expect(c.paymentFee).toBe(6); // 1000 × 0.6%
    expect(c.logistics).toBe(55); // 10 单 × ¥5.5
    expect(c.promotion).toBe(200);
    // 无 SKU 明细 → 退化为综合单瓶成本估算（COGS 口径 ¥14.59），并如实标注
    expect(c.material).toBeCloseTo(SKU_MASTER_BASELINE.weightedUnitCostCogs * 10, 2);
    expect(c.quality).toBe('estimated');
    expect(c.assumptions.some((a) => a.includes('综合单瓶成本'))).toBe(true);
    expect(c.assumptions.some((a) => a.includes('一单一瓶'))).toBe(true);
  });

  it('拼多多扣点率与其余平台不同 —— 佣金必须逐平台算，不能用一个平均值', () => {
    const daily = [
      ...buildDay('2026-09-10', { taobao: [1000, 0, 0, 10] }),
      ...buildDay('2026-09-10', { pdd: [1000, 0, 0, 10] }),
    ];
    const w = buildWindow('today', daily, '2026-09-10');
    const c = deriveCosts({ daily, window: w, skuMaster: skuMaster(), costPolicy: costPolicy() });
    // 淘宝 1000×0.05 = 50，拼多多 1000×0.006 = 6
    expect(c.commission).toBe(56);
  });

  it('有 SKU×日 明细时物料取真实 BOM，而不是综合估算', () => {
    const daily = buildDay('2026-09-10', { taobao: [1000, 0, 200, 10] });
    const w = buildWindow('month', daily, TODAY);
    const c = deriveCosts({
      daily,
      window: w,
      skuMaster: skuMaster(),
      costPolicy: costPolicy(),
      skuDaily: skuDailyRecords(),
    });

    // COGS 口径逐 SKU 单瓶成本 × 件数，取值全部来自夹具（不硬编码，避免重演成本漂移）
    const costOf = (sku: string) => skuMaster().find((s) => s.sku === sku)!.unitCostCogs!;
    const expected =
      150 * costOf('不在场50ml') + 110 * costOf('暗戳戳100ml') + 50 * costOf('西西里白橘50ml');
    expect(c.material).toBeCloseTo(expected, 2);
    expect(c.quality).toBe('exact');
    expect(c.assumptions.some((a) => a.includes('综合单瓶成本'))).toBe(false);
  });

  it('物流按「一单一瓶」近似，并在假设中说明', () => {
    const daily = buildDay('2026-09-10', { taobao: [1000, 0, 200, 10] });
    const w = buildWindow('month', daily, TODAY);
    const c = deriveCosts({
      daily,
      window: w,
      skuMaster: skuMaster(),
      costPolicy: costPolicy(),
      skuDaily: skuDailyRecords(),
    });
    // SKU×日 合计 310 瓶（(6+9+4+7+3+2)×10）
    expect(c.logistics).toBeCloseTo(310 * 5.5, 2);
    expect(c.assumptions.some((a) => a.includes('一单一瓶'))).toBe(true);
  });

  it('未取数的科目按 0 参与计算，但必须出现在假设里（C7）', () => {
    const daily = buildDay('2026-09-10', { taobao: [1000, 0, 200, 10] });
    const w = buildWindow('today', daily, '2026-09-10');
    const c = deriveCosts({ daily, window: w, skuMaster: skuMaster(), costPolicy: costPolicy() });
    expect(c.anchorService).toBe(0);
    expect(c.nonDeductible).toBe(0);
    expect(c.assumptions.some((a) => a.includes('灌装'))).toBe(true);
    expect(c.assumptions.some((a) => a.includes('人工'))).toBe(true);
    expect(c.assumptions.some((a) => a.includes('包材损耗'))).toBe(true);
  });

  it('toCostBreakdown 只保留科目金额（元数据不进税务计算）', () => {
    const daily = buildDay('2026-09-10', { taobao: [1000, 0, 200, 10] });
    const w = buildWindow('today', daily, '2026-09-10');
    const c = deriveCosts({ daily, window: w, skuMaster: skuMaster(), costPolicy: costPolicy() });
    const b = toCostBreakdown(c);
    expect(Object.keys(b).sort()).toEqual(
      ['anchorService', 'commission', 'logistics', 'material', 'nonDeductible', 'paymentFee', 'promotion'].sort(),
    );
    expect(b.material).toBe(c.material);
  });
});
