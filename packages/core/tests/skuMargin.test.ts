import { describe, expect, it } from 'vitest';
import {
  allocatePromotion,
  computeSkuMargins,
  isDataGap,
  roiZone,
  rollupBySku,
  shareBy,
  skuPlatformBreakdown,
} from '../src/index.ts';
import { costPolicy, skuDailyRecords, skuMaster } from './fixtures/dataset.ts';

const PERIOD = { from: '2026-09-01', to: '2026-09-10' };

describe('推广分摊', () => {
  it('按收入占比分摊，且 Σ分摊 = 池子', () => {
    const r = allocatePromotion(
      [
        { key: 'a', revenue: 500, qty: 5 },
        { key: 'b', revenue: 300, qty: 3 },
        { key: 'c', revenue: 200, qty: 2 },
      ],
      1000,
      'by-revenue',
    );
    expect(r.map((x) => x.promotion)).toEqual([500, 300, 200]);
    expect(r.every((x) => x.allocated)).toBe(true);
    expect(r.reduce((a, x) => a + x.promotion, 0)).toBeCloseTo(1000, 2);
  });

  it('直连优先，剩余池子再分摊；直连行不标 allocated', () => {
    const r = allocatePromotion(
      [
        { key: 'a', revenue: 500, qty: 5, promotionDirect: 100 },
        { key: 'b', revenue: 300, qty: 3 },
        { key: 'c', revenue: 200, qty: 2 },
      ],
      1000,
      'by-revenue',
    );
    const a = r.find((x) => x.key === 'a')!;
    expect(a.promotion).toBe(100);
    expect(a.allocated).toBe(false);
    expect(a.basis).toBe('direct');
    expect(r.find((x) => x.key === 'b')!.promotion).toBeCloseTo(540, 2);
    expect(r.find((x) => x.key === 'c')!.promotion).toBeCloseTo(360, 2);
    expect(r.reduce((s, x) => s + x.promotion, 0)).toBeCloseTo(1000, 2);
  });

  it('by-qty 与 by-revenue 得到不同结果（策略真的生效）', () => {
    const items = [
      { key: 'a', revenue: 100, qty: 6 },
      { key: 'b', revenue: 400, qty: 4 },
      { key: 'c', revenue: 500, qty: 0 },
    ];
    expect(allocatePromotion(items, 1000, 'by-revenue').map((x) => x.promotion)).toEqual([100, 400, 500]);
    expect(allocatePromotion(items, 1000, 'by-qty').map((x) => x.promotion)).toEqual([600, 400, 0]);
  });

  it('尾差归入最大分摊行，保证可对账', () => {
    const r = allocatePromotion(
      [
        { key: 'a', revenue: 1, qty: 1 },
        { key: 'b', revenue: 1, qty: 1 },
        { key: 'c', revenue: 1, qty: 1 },
      ],
      100,
    );
    expect(r.reduce((s, x) => s + x.promotion, 0)).toBeCloseTo(100, 2);
    expect(r.map((x) => x.promotion).sort((p, q) => q - p)[0]).toBeCloseTo(33.34, 2);
  });

  it('全零权重时均摊，仍标记为分摊', () => {
    const r = allocatePromotion(
      [
        { key: 'a', revenue: 0, qty: 0 },
        { key: 'b', revenue: 0, qty: 0 },
      ],
      10,
    );
    expect(r.map((x) => x.promotion)).toEqual([5, 5]);
    expect(r.every((x) => x.allocated)).toBe(true);
  });

  it('空输入返回空数组', () => {
    expect(allocatePromotion([], 100)).toEqual([]);
  });

  it('shareBy 给出占比且降序', () => {
    const s = shareBy([
      { key: 'a', revenue: 100, qty: 1 },
      { key: 'b', revenue: 300, qty: 9 },
    ]);
    expect(s[0]!.key).toBe('b');
    expect(s[0]!.share).toBeCloseTo(0.75, 4);
  });
});

describe('单品真实毛利', () => {
  it('物料成本用真实 BOM 单位成本乘件数，绝不等权估算', () => {
    const margins = computeSkuMargins(skuDailyRecords(), skuMaster(), costPolicy(), PERIOD);
    expect(isDataGap(margins)).toBe(false);
    const rows = margins as Exclude<typeof margins, { kind: 'data-gap' }>;

    const tb = rows.find((m) => m.sku === '不在场50ml' && m.platform === 'taobao')!;
    expect(tb.qty).toBe(60); // 6 件/天 × 10 天
    expect(tb.revenue).toBeCloseTo(198 * 60, 2);
    expect(tb.cogs).toBeCloseTo(14.59 * 60, 2);
    expect(tb.commission).toBeCloseTo(198 * 60 * 0.05, 2);
    expect(tb.paymentFee).toBeCloseTo(198 * 60 * 0.006, 2);
    expect(tb.logistics).toBeCloseTo(60 * 5.5, 2);
    expect(tb.net).toBeCloseTo(
      198 * 60 - 14.59 * 60 - 198 * 60 * 0.05 - 198 * 60 * 0.006 - 60 * 5.5,
      2,
    );
    expect(tb.grossMarginRate).toBeGreaterThan(0.9);
  });

  it('未指定推广池时退化为 0 并如实标注「未提供平台推广费池」', () => {
    const rows = computeSkuMargins(skuDailyRecords(), skuMaster(), costPolicy(), PERIOD) as Exclude<
      ReturnType<typeof computeSkuMargins>,
      { kind: 'data-gap' }
    >;
    expect(rows.every((m) => m.promotion === 0)).toBe(true);
    expect(rows.every((m) => m.allocated)).toBe(true);
    expect(rows[0]!.assumptions.some((a) => a.includes('未提供平台推广费池'))).toBe(true);
  });

  it('给定推广池后按平台分摊，且平台内合计等于池子', () => {
    const pool = { taobao: 18_000, douyin: 32_000 } as const;
    const rows = computeSkuMargins(skuDailyRecords(), skuMaster(), costPolicy(), {
      ...PERIOD,
      platformPromotionPool: pool,
    }) as Exclude<ReturnType<typeof computeSkuMargins>, { kind: 'data-gap' }>;

    for (const [platform, amount] of Object.entries(pool)) {
      const sum = rows.filter((m) => m.platform === platform).reduce((a, m) => a + m.promotion, 0);
      expect(sum).toBeCloseTo(amount, 1);
    }
    expect(rows.every((m) => m.assumptions.some((a) => a.includes('分摊')))).toBe(true);
  });

  it('未映射到主数据的 SKU 不计入毛利（交由 DQ warn 提示）', () => {
    const extra = [
      ...skuDailyRecords(),
      {
        date: '2026-09-01',
        platform: 'taobao' as const,
        sku: '外星人香水50ml',
        qty: 5,
        avgPrice: 100,
        refundQty: 0,
        refundAmount: 0,
      },
    ];
    const rows = computeSkuMargins(extra, skuMaster(), costPolicy(), PERIOD) as Exclude<
      ReturnType<typeof computeSkuMargins>,
      { kind: 'data-gap' }
    >;
    expect(rows.some((m) => m.sku === '外星人香水50ml')).toBe(false);
  });

  it('源数据缺失时返回结构化 DataGap，而不是 null / 补 0', () => {
    const noDaily = computeSkuMargins([], skuMaster(), costPolicy(), PERIOD);
    expect(isDataGap(noDaily)).toBe(true);
    expect((noDaily as { scope: string }).scope).toBe('sku-daily');
    expect((noDaily as { steps: string[] }).steps.length).toBeGreaterThanOrEqual(2);

    const noMaster = computeSkuMargins(skuDailyRecords(), [], costPolicy(), PERIOD);
    expect((noMaster as { scope: string }).scope).toBe('sku-master');

    const noPolicy = computeSkuMargins(skuDailyRecords(), skuMaster(), null, PERIOD);
    expect((noPolicy as { scope: string }).scope).toBe('cost-policy');
  });

  it('区间外无数据时同样返回 DataGap', () => {
    const r = computeSkuMargins(skuDailyRecords(), skuMaster(), costPolicy(), {
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(isDataGap(r)).toBe(true);
  });

  it('ROI 分档', () => {
    expect(roiZone(2)).toBe('safe');
    expect(roiZone(1.2)).toBe('warning');
    expect(roiZone(0.4)).toBe('loss');
    expect(roiZone(null)).toBe('unknown');
  });
});

describe('SKU 汇总视图', () => {
  it('rollupBySku 汇总多平台并按营收降序', () => {
    const rows = computeSkuMargins(skuDailyRecords(), skuMaster(), costPolicy(), PERIOD) as Exclude<
      ReturnType<typeof computeSkuMargins>,
      { kind: 'data-gap' }
    >;
    const roll = rollupBySku(rows);
    // 不在场：198 × 150 件 = 29,700；暗戳戳：268 × 110 件 = 29,480 —— 前者略高
    expect(roll[0]!.sku).toBe('不在场50ml');
    expect(roll[1]!.sku).toBe('暗戳戳50ml');
    const bleu = roll.find((r) => r.sku === '不在场50ml')!;
    expect(bleu.qty).toBe(150); // (6+9) × 10 天
    expect(bleu.platformCount).toBe(2);
    expect(roll.map((r) => r.revenue)).toEqual([...roll.map((r) => r.revenue)].sort((a, b) => b - a));
  });

  it('skuPlatformBreakdown 给出渠道结构', () => {
    const rows = computeSkuMargins(skuDailyRecords(), skuMaster(), costPolicy(), PERIOD) as Exclude<
      ReturnType<typeof computeSkuMargins>,
      { kind: 'data-gap' }
    >;
    const b = skuPlatformBreakdown(rows, '不在场50ml');
    expect(b).toHaveLength(2);
    expect(b[0]!.platform).toBe('douyin');
    expect(b.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1, 3);
  });
});
