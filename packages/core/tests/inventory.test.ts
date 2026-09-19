import { describe, expect, it } from 'vitest';
import {
  avgDailySales,
  buildWindow,
  channelBreakdown,
  inventoryCoverage,
  inventorySummary,
} from '../src/index.ts';
import type { InventoryItem } from '../src/index.ts';
import { septemberRecords, skuDailyRecords, skuMaster, TODAY } from './fixtures/dataset.ts';

const items: InventoryItem[] = [
  { sku: '不在场50ml', onHand: 100, inTransit: 50, leadTimeDays: 7, safetyDays: 7, asOf: TODAY },
  { sku: '暗戳戳50ml', onHand: 0, inTransit: 0, leadTimeDays: 10, safetyDays: 7, asOf: TODAY },
  { sku: '西西里白橘50ml', onHand: 200, inTransit: 0, leadTimeDays: 7, safetyDays: 5, asOf: TODAY },
  { sku: '绽放50ml', onHand: 300, inTransit: 0, leadTimeDays: 7, safetyDays: 7, asOf: TODAY },
];

describe('库存覆盖与补货建议', () => {
  it('日均销量取近 30 天实测；无数据返回 null 而不是 0', () => {
    expect(avgDailySales(skuDailyRecords(), '不在场50ml', TODAY, 30).value).toBeCloseTo(15, 2);
    expect(avgDailySales(skuDailyRecords(), '绽放50ml', TODAY, 30).value).toBeNull();
    expect(avgDailySales(skuDailyRecords(), '绽放50ml', TODAY, 30).observedDays).toBe(0);
  });

  it('覆盖天数 / 补货点 / 建议量的手算校验', () => {
    const [bleu] = inventoryCoverage(items, skuDailyRecords(), { today: TODAY });
    expect(bleu).toBeDefined();
    // 日均 15 → (100+50)/15 = 10 天
    expect(bleu!.avgDailySales).toBeCloseTo(15, 2);
    expect(bleu!.coverDays).toBeCloseTo(10, 2);
    expect(bleu!.coverDaysOnHand).toBeCloseTo(6.67, 2);
    // 补货点 = 15 × (7+7) = 210
    expect(bleu!.reorderPoint).toBeCloseTo(210, 2);
    // 目标覆盖 7+7+30 = 44 天 → 15×44 − 150 = 510
    expect(bleu!.suggestedQty).toBe(510);
    expect(bleu!.status).toBe('watch');
    expect(bleu!.assumptions.some((a) => a.includes('在途'))).toBe(true);
  });

  it('断货 / 超储 / 健康 / 未知 四态判定', () => {
    const cov = inventoryCoverage(items, skuDailyRecords(), { today: TODAY });
    const bySku = Object.fromEntries(cov.map((c) => [c.sku, c]));
    expect(bySku['暗戳戳50ml']!.status).toBe('stockout');
    expect(bySku['西西里白橘50ml']!.status).toBe('healthy');
    expect(bySku['绽放50ml']!.status).toBe('unknown');
    expect(bySku['绽放50ml']!.suggestedQty).toBe(0);
    expect(bySku['绽放50ml']!.coverDays).toBeNull();
  });

  it('超储会提示停止补货', () => {
    const cov = inventoryCoverage(
      [{ sku: '不在场50ml', onHand: 2000, inTransit: 0, leadTimeDays: 7, safetyDays: 7, asOf: TODAY }],
      skuDailyRecords(),
      { today: TODAY },
    );
    expect(cov[0]!.status).toBe('overstock');
    expect(cov[0]!.message).toContain('暂停补货');
  });

  it('MOQ 向上取整', () => {
    const cov = inventoryCoverage(
      [{ sku: '不在场50ml', onHand: 0, inTransit: 0, leadTimeDays: 7, safetyDays: 7, asOf: TODAY, moq: 500 }],
      skuDailyRecords(),
      { today: TODAY },
    );
    expect(cov[0]!.suggestedQty % 500).toBe(0);
    expect(cov[0]!.assumptions.some((a) => a.includes('最小起订量'))).toBe(true);
  });

  it('不含在途时覆盖天数更短', () => {
    const [withTransit] = inventoryCoverage(items, skuDailyRecords(), { today: TODAY });
    const [without] = inventoryCoverage(items, skuDailyRecords(), { today: TODAY, includeInTransit: false });
    expect(without!.coverDays!).toBeLessThan(withTransit!.coverDays!);
  });

  it('汇总按状态分桶并给出待补货金额', () => {
    const cov = inventoryCoverage(items, skuDailyRecords(), { today: TODAY });
    const cost = new Map(skuMaster().map((s) => [s.sku, s.unitCost]));
    const sum = inventorySummary(cov, (sku) => cost.get(sku) ?? 0);
    expect(sum.counts.stockout).toBe(1);
    expect(sum.counts.unknown).toBe(1);
    expect(sum.suggestedTotalQty).toBeGreaterThan(0);
    expect(sum.attention).toContain('暗戳戳50ml');
    expect(sum.suggestedTotalAmount).toBeGreaterThan(0);
  });
});

describe('渠道分解', () => {
  const records = septemberRecords();
  const window = buildWindow('month', records, TODAY);

  it('5 个平台齐全，占比合计 100%', () => {
    const r = channelBreakdown(records, window, skuMaster());
    expect(r.channels).toHaveLength(5);
    expect(r.activePlatforms).toBe(5);
    expect(r.channels.reduce((a, c) => a + c.shareOfRevenue, 0)).toBeCloseTo(100, 1);
    expect(r.channels[0]!.platform).toBe('douyin');
  });

  it('净收入重算（不读原表净收入列）', () => {
    const r = channelBreakdown(records, window, skuMaster());
    for (const c of r.channels) {
      expect(c.net).toBeCloseTo(c.revenue - c.refund - c.promotion, 2);
    }
  });

  it('渠道集中度给出 HHI 与结论', () => {
    const r = channelBreakdown(records, window, skuMaster());
    expect(r.hhi).toBeGreaterThan(0.25);
    expect(r.hhi).toBeLessThan(0.5);
    expect(r.concentration?.level).toBe('medium');
    expect(r.concentration?.message).toContain('抖音');
  });

  it('单渠道独大时判为高集中度', () => {
    const solo = septemberRecords().filter((x) => x.platform === 'douyin');
    const r = channelBreakdown(solo, window, skuMaster());
    expect(r.hhi).toBeCloseTo(1, 2);
    expect(r.concentration?.level).toBe('high');
  });

  it('缺数据的渠道默认保留（active=false），可选择只看有数据的', () => {
    const only3 = septemberRecords().filter((x) => ['taobao', 'douyin', 'pdd'].includes(x.platform));
    expect(channelBreakdown(only3, window, skuMaster()).channels).toHaveLength(5);
    const filtered = channelBreakdown(only3, window, skuMaster(), true);
    expect(filtered.channels).toHaveLength(3);
    expect(filtered.activePlatforms).toBe(3);
  });
});
