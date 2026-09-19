import { describe, expect, it } from 'vitest';
import {
  aggregatePeriod,
  buildAlerts,
  channelBreakdown,
  buildWindow,
  inventoryCoverage,
  platformLabel,
} from '../src/index.ts';
import type { DailyRecord } from '../src/index.ts';
import { buildDay, septemberRecords, skuDailyRecords, skuMaster } from './fixtures/dataset.ts';

const TODAY = '2026-09-10';

function lossRecords(promotion: number): DailyRecord[] {
  return buildDay('2026-09-10', {
    taobao: [4_000, 0, promotion, 30],
    douyin: [6_000, 0, promotion * 1.5, 40],
  });
}

function context(records: DailyRecord[]) {
  const window = buildWindow('month', records, TODAY);
  return {
    period: aggregatePeriod(records, 'month', TODAY, skuMaster()),
    channels: channelBreakdown(records, window, skuMaster()),
    daily: records,
  };
}

describe('经营预警', () => {
  it('真实 ROI < 1 时为 critical，并给出缺口金额', () => {
    const records = lossRecords(5_000);
    const alerts = buildAlerts(context(records));
    const a = alerts.find((x) => x.id === 'roi-loss');
    expect(a).toBeDefined();
    expect(a!.level).toBe('critical');
    expect(a!.message).toContain('保本线');
    expect(a!.evidence.length).toBeGreaterThan(0);
  });

  it('真实 ROI 介于 1–1.5 时为 warning，不误报为亏损', () => {
    // 物料 = 16.79×70 = 1175.3；营收 10000 → 需要 promotion 使 ROI 落在 (1,1.5)
    const records = buildDay('2026-09-10', { taobao: [10_000, 0, 5_800, 70] });
    const alerts = buildAlerts(context(records));
    expect(alerts.some((x) => x.id === 'roi-loss')).toBe(false);
    expect(alerts.some((x) => x.id === 'roi-below-target')).toBe(true);
  });

  it('无目标时明确提示「未设置」，不臆造达成率', () => {
    const alerts = buildAlerts(context(septemberRecords()));
    expect(alerts.some((x) => x.id === 'target-missing')).toBe(true);
    expect(alerts.some((x) => x.id === 'target-revenue')).toBe(false);
  });

  it('设置目标后给出达成率（部分月用整月预估口径并标注估算）', () => {
    const alerts = buildAlerts({
      ...context(septemberRecords()),
      targets: { monthlyRevenue: 3_000_000 },
    });
    const a = alerts.find((x) => x.id === 'target-revenue');
    expect(a).toBeDefined();
    expect(a!.level).toBe('critical'); // 达成率很低
    expect(a!.evidence.some((e) => e.value.includes('估算'))).toBe(true);
  });

  it('退款率与推广费率越线各自告警', () => {
    const records = buildDay('2026-09-10', { taobao: [10_000, 1_800, 4_000, 60] });
    const alerts = buildAlerts(context(records));
    expect(alerts.some((x) => x.id === 'refund-rate')).toBe(true);
    expect(alerts.some((x) => x.id === 'promo-rate')).toBe(true);
  });

  it('渠道单均亏损逐渠道告警', () => {
    const alerts = buildAlerts(context(lossRecords(5_000)));
    expect(alerts.filter((x) => x.id.startsWith('channel-loss-')).length).toBeGreaterThanOrEqual(1);
  });

  it('库存断货 / 告急进入预警', () => {
    const inventory = inventoryCoverage(
      [{ sku: '暗戳戳50ml', onHand: 0, inTransit: 0, leadTimeDays: 10, safetyDays: 7, asOf: TODAY }],
      skuDailyRecords(),
      { today: TODAY },
    );
    const alerts = buildAlerts({ ...context(septemberRecords()), inventory });
    const a = alerts.find((x) => x.category === 'inventory');
    expect(a).toBeDefined();
    expect(a!.level).toBe('critical');
  });

  it('营收连续 3 天下滑时告警', () => {
    const descending = [
      ...buildDay('2026-09-07', { taobao: [10_000, 0, 100, 10] }),
      ...buildDay('2026-09-08', { taobao: [8_000, 0, 100, 10] }),
      ...buildDay('2026-09-09', { taobao: [6_000, 0, 100, 10] }),
      ...buildDay('2026-09-10', { taobao: [4_000, 0, 100, 10] }),
    ];
    const alerts = buildAlerts(context(descending));
    expect(alerts.some((x) => x.id === 'revenue-decline')).toBe(true);
  });

  it('critical 排在 warning 之前，同级按影响金额降序', () => {
    const alerts = buildAlerts(context(lossRecords(6_000)));
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < alerts.length; i += 1) {
      expect(rank[alerts[i - 1]!.level]).toBeLessThanOrEqual(rank[alerts[i]!.level]);
    }
  });

  it('平台中文名由内核提供，前端不必自建一份', () => {
    expect(platformLabel('taobao')).toBe('淘宝');
    expect(platformLabel('tiktok')).toBe('tiktok');
  });
});
