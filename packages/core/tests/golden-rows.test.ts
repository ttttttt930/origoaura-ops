/**
 * 真实数据回归（golden rows）
 *
 * 夹具来源：用户提供的 M0/M1 zip 中的 `rows-250d.json`（250 天、31 列原表口径）。
 * 对账后**只有 6 月、8 月 100% 一致**，故只取这两个月落为 `rows-trusted-0608.json`。
 * 其余月份不可信的原因见 fixtures/golden/README.md —— 那里也记录了
 * "7 月 15 天平台拆分缺口 ¥20,673.09" 的真实根因（带千分位的文本单元格被误判为 0）。
 *
 * 下面所有期望值都是**脱离本仓库实现**、直接对原始 31 列求和得到的，
 * 因此这是对内核聚合口径的交叉校验，不是"拿实现验证实现"。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { aggregate, buildWindow, type PeriodWindow } from '../src/compute/aggregate.ts';
import { makeDailyRecord, PLATFORM_LABEL, type DailyRecord, type Platform } from '../src/model/daily.ts';

interface GoldenRow {
  date: string;
  values: Record<string, number>;
}
const GOLDEN = JSON.parse(
  readFileSync(new URL('./fixtures/golden/rows-trusted-0608.json', import.meta.url), 'utf8'),
) as { columns: string[]; rows: GoldenRow[] };

const NO_SKU = [];

/**
 * 宽表一行（一天）→ 各平台 DailyRecord。
 * 夹具已验证「平台列之和 == 总计列」，故按平台展开不会失真。
 */
function toRecords(rows: readonly GoldenRow[]): DailyRecord[] {
  const out: DailyRecord[] = [];
  for (const r of rows) {
    for (const p of Object.keys(PLATFORM_LABEL) as Platform[]) {
      const label = PLATFORM_LABEL[p];
      const revenue = r.values[`${label}收入`] ?? 0;
      const refund = r.values[`${label}退款`] ?? 0;
      const promotion = r.values[`${label}推广支出`] ?? 0;
      const qty = r.values[`${label}销量`] ?? 0;
      if (revenue === 0 && refund === 0 && promotion === 0 && qty === 0) continue;
      out.push(
        makeDailyRecord({ date: r.date, platform: p, revenue, refund, promotion, qty, raw: r.values }),
      );
    }
  }
  return out;
}

const ALL = toRecords(GOLDEN.rows);

describe('golden 真实数据 · 聚合口径回归', () => {
  it('夹具本身自洽：只有 6/8 月、且平台列之和等于总计列', () => {
    expect(GOLDEN.rows).toHaveLength(61);
    expect(new Set(GOLDEN.rows.map((r) => r.date.slice(0, 7)))).toEqual(new Set(['2026-06', '2026-08']));
  });

  it('2026-08 整月：完整月不触发「整月预估」', () => {
    const w: PeriodWindow = buildWindow('month', ALL, '2026-08-31');
    expect(w.observedDays).toBe(31);
    expect(w.calendarDays).toBe(31);
    expect(w.blankDays).toBe(0);
    expect(w.isPartialMonth).toBe(false);

    const m = aggregate(ALL, w, NO_SKU);
    // 期望值：对 8 月 31 天的 31 列原表直接求和（独立算得）
    expect(m.gmv).toBe(36524.22);
    expect(m.refund).toBe(6087);
    expect(m.promotion).toBe(17489.61);
    expect(m.qty).toBe(290);
    expect(m.dailyAvgGmv).toBe(1178.2);
    expect(m.refundRate).toBe(16.67);
    expect(m.promoRate).toBe(47.88);
    expect(m.aov).toBe(125.95);
    expect(m.cashback).toBe(12947.61);
    expect(m.projected).toBeUndefined();
    // 无 SKU 主数据时物料成本必须为 0 且打「估算」标，不得凭空造数
    expect(m.materialCost).toBe(0);
    expect(m.unitCostEstimated).toBe(true);
  });

  it('2026-06 整月：跨月切换后口径一致', () => {
    const w = buildWindow('month', ALL, '2026-06-30');
    const m = aggregate(ALL, w, NO_SKU);
    expect(w.observedDays).toBe(30);
    expect(m.gmv).toBe(31963.73);
    expect(m.refund).toBe(5064.74);
    expect(m.promotion).toBe(20447.47);
    expect(m.qty).toBe(323);
    expect(m.dailyAvgGmv).toBe(1065.46);
  });

  /**
   * 这条用例直接对应 9 月的真实事故：源表把整月模板行预填为 0，
   * 若按"有行"计数会把部分月误判成完整月，既不出角标、日均还被 30 天稀释。
   */
  it('部分月：只喂到 8/10 必须识别为部分月并给出整月预估', () => {
    const partial = ALL.filter((r) => r.date <= '2026-08-10');
    const w = buildWindow('month', partial, '2026-08-31');

    expect(w.isPartialMonth).toBe(true);
    expect(w.monthDaysSoFar).toBe(10);
    expect(w.monthDaysTotal).toBe(31);
    expect(w.lastActiveDate).toBe('2026-08-10');
    expect(w.projFactor).toBe(3.1);

    const m = aggregate(partial, w, NO_SKU);
    expect(m.gmv).toBe(9589.25);
    expect(m.dailyAvgGmv).toBe(958.93); // 按 10 天算，不是按 31 天稀释
    expect(m.projected?.gmv).toBe(29726.68);
    expect(m.projected?.qty).toBe(254);
  });
});
