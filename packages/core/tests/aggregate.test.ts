import { describe, expect, it } from 'vitest';
import {
  aggregate,
  aggregatePeriod,
  blendedUnitCost,
  buildPeriodPair,
  buildWindow,
  heroCards,
} from '../src/index.ts';
import { buildDay, septemberRecords, skuMaster, TODAY } from './fixtures/dataset.ts';

/** 覆盖 2026-09-01 ~ 09-30 的完整月 */
function fullSeptember() {
  const out = [];
  for (let d = 1; d <= 30; d += 1) {
    out.push(...buildDay(`2026-09-${String(d).padStart(2, '0')}`, { taobao: [1000, 50, 200, 10] }));
  }
  return out;
}

describe('周期窗口 —— 口径与 v6 修正一致', () => {
  it('month：部分月双口径（已过天数 + 整月预估系数）', () => {
    const w = buildWindow('month', septemberRecords(), TODAY);
    expect(w.start).toBe('2026-09-01');
    expect(w.end).toBe('2026-09-30');
    expect(w.observedDays).toBe(10);
    expect(w.isPartialMonth).toBe(true);
    expect(w.monthDaysSoFar).toBe(10);
    expect(w.monthDaysTotal).toBe(30);
    expect(w.projFactor).toBe(3);
  });

  it('month：走完的整月不再标记 partial，也不做外推', () => {
    const w = buildWindow('month', fullSeptember(), '2026-09-30');
    expect(w.isPartialMonth).toBe(false);
    expect(w.projFactor).toBe(1);
  });

  it('month：源表预填的全 0 模板行不计入「已过天数」（不能被当成整月）', () => {
    // 复刻真实工作簿：9/1–9/10 有数，9/11–9/30 是预填好公式的全 0 模板行
    const out = [...septemberRecords()];
    for (let d = 11; d <= 30; d += 1) {
      out.push(
        ...buildDay(`2026-09-${String(d).padStart(2, '0')}`, {
          taobao: [0, 0, 0, 0],
          douyin: [0, 0, 0, 0],
        }),
      );
    }
    const w = buildWindow('month', out, TODAY);
    expect(w.calendarDays).toBe(30);
    expect(w.observedDays).toBe(10);
    expect(w.blankDays).toBe(20);
    expect(w.isPartialMonth).toBe(true);
    expect(w.projFactor).toBe(3);
    expect(w.lastActiveDate).toBe('2026-09-10');
    // 日均必须按有数据天数算，否则会被 20 个空行稀释成三分之一
    const m = aggregate(out, w, skuMaster());
    expect(m.dailyAvgGmv).toBeCloseTo(m.gmv / 10, 2);
  });

  it('month 同比严格同长度：10 天 vs 上月前 10 天（禁止整月 vs 部分月）', () => {
    const { current, previous, compareLabel } = buildPeriodPair('month', septemberRecords(), TODAY);
    expect(previous).not.toBeNull();
    expect(previous!.start).toBe('2026-08-01');
    expect(previous!.end).toBe('2026-08-10');
    expect(compareLabel).toBe('vs 上月同期');
    // 长度相等是这条口径的核心保证
    expect(previous!.end.slice(8)).toBe(current.monthDaysSoFar?.toString().padStart(2, '0'));
  });

  it('month 对比遇到 2 月时按被比月天数收敛（不越界）', () => {
    const { previous } = buildPeriodPair('month', septemberRecords(), '2026-03-31');
    expect(previous!.end).toBe('2026-02-28');
  });

  it('week 是滚动近 7 天，不是 ISO 自然周（周一查看不会失真）', () => {
    const { current, previous, compareLabel } = buildPeriodPair('week', septemberRecords(), TODAY);
    expect(current.start).toBe('2026-09-04');
    expect(current.end).toBe('2026-09-10');
    expect(current.observedDays).toBe(7);
    expect(previous!.start).toBe('2026-08-28');
    expect(previous!.end).toBe('2026-09-03');
    expect(compareLabel).toBe('vs 上周');
  });

  it('today / year / all 的对比与标签', () => {
    const recs = septemberRecords();
    expect(buildPeriodPair('today', recs, TODAY).compareLabel).toBe('vs 昨日');
    expect(buildPeriodPair('year', recs, TODAY).current.start).toBe('2026-01-01');
    expect(buildPeriodPair('all', recs, TODAY).previous).toBeNull();
  });
});

describe('综合单瓶物料成本', () => {
  it('按月销预估加权（不是等权），且永远标记为估算', () => {
    const r = blendedUnitCost(skuMaster());
    expect(r.basis).toBe('weighted-by-est-qty');
    expect(r.value).toBeCloseTo(16.79, 2);
    expect(r.estimated).toBe(true);
  });

  it('无月销预估时退化为等权并如实标注', () => {
    const noEst = skuMaster().map((s) => ({ ...s, estMonthlyQty: undefined }));
    const r = blendedUnitCost(noEst);
    expect(r.basis).toBe('equal-weight');
    expect(r.value).toBeCloseTo((14.59 + 23.08 + 13.72 + 15.4 + 16.8) / 5, 2);
  });

  it('无在售 SKU 时返回 0 而非 NaN', () => {
    expect(blendedUnitCost([]).value).toBe(0);
    expect(blendedUnitCost(skuMaster().map((s) => ({ ...s, status: 'halted' as const }))).value).toBe(0);
  });
});

describe('聚合与 Hero 卡片', () => {
  it('单日单平台的手算校验', () => {
    const records = buildDay('2026-09-10', { taobao: [1000, 50, 200, 10] });
    const w = buildWindow('today', records, '2026-09-10');
    const m = aggregate(records, w, skuMaster());

    expect(m.gmv).toBe(1000);
    expect(m.refund).toBe(50);
    expect(m.promotion).toBe(200);
    expect(m.qty).toBe(10);
    expect(m.materialCost).toBeCloseTo(16.79 * 10, 2);
    expect(m.realProfit).toBeCloseTo(1000 - 167.9 - 200, 2);
    expect(m.cashback).toBeCloseTo(1000 - 200 - 50, 2);
    expect(m.realRoi).toBeCloseTo(1000 / (167.9 + 200), 2);
    expect(m.roi).toBeCloseTo(5, 2);
    expect(m.aov).toBe(100);
    expect(m.refundRate).toBe(5);
    expect(m.promoRate).toBe(20);
    expect(m.unitCostEstimated).toBe(true);
  });

  it('无推广时 ROI 为 null（不是 Infinity，也不误报为亏损）', () => {
    const records = buildDay('2026-09-10', { taobao: [1000, 0, 0, 10] });
    const m = aggregate(records, buildWindow('today', records, '2026-09-10'), skuMaster());
    expect(m.roi).toBeNull();
    expect(m.realRoi).not.toBeNull();
  });

  it('部分月给出整月预估，且预估只在 partial 时出现', () => {
    const res = aggregatePeriod(septemberRecords(), 'month', TODAY, skuMaster());
    expect(res.window.isPartialMonth).toBe(true);
    expect(res.metrics.projected).toBeDefined();
    expect(res.metrics.projected!.gmv).toBeCloseTo(res.metrics.gmv * 3, 2);

    const full = aggregatePeriod(fullSeptember(), 'month', '2026-09-30', skuMaster());
    expect(full.metrics.projected).toBeUndefined();
  });

  it('Hero 四卡：营收 / 真实净利 / 现金回款 / 真实 ROI', () => {
    const res = aggregatePeriod(septemberRecords(), 'month', TODAY, skuMaster());
    const cards = heroCards(res);
    expect(cards.map((c) => c.key)).toEqual(['gmv', 'realProfit', 'cashback', 'realRoi']);
    expect(cards[0]!.title).toContain('截至 10/30天');
    expect(cards[0]!.sub).toContain('整月预估');
    expect(cards[0]!.sub).toContain('估算');
    expect(cards[1]!.sub).toContain('物料');
    expect(cards[3]!.zone).toBeDefined();
  });

  it('真实 ROI 分档：≥1.5 安全 / 1–1.5 保本线上 / <1 亏损', () => {
    const zoneOf = (promotion: number) => {
      const records = buildDay('2026-09-10', { taobao: [10_000, 0, promotion, 50] });
      const res = aggregatePeriod(records, 'today', '2026-09-10', skuMaster());
      return heroCards(res)[3]!.zone;
    };
    // 物料 16.79×50 = 839.5；promotion 5000 → ROI = 10000/5839.5 = 1.71 → safe
    expect(zoneOf(5000)).toBe('safe');
    // promotion 6500 → 10000/7339.5 = 1.36 → warning
    expect(zoneOf(6500)).toBe('warning');
    // promotion 10000 → 10000/10839.5 = 0.92 → loss
    expect(zoneOf(10_000)).toBe('loss');
  });

  it('环比增幅在基期为 0 时为 null', () => {
    const records = buildDay('2026-09-10', { taobao: [1000, 0, 0, 1] });
    const res = aggregatePeriod(records, 'today', '2026-09-10', skuMaster());
    expect(res.delta).toBeNull();
  });
});
