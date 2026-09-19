import { describe, expect, it } from 'vitest';
import { formatDqReport, groupDays, runDq, summarizeByRule } from '../src/index.ts';
import {
  allColumns,
  buildDay,
  julyIncidentRecords,
  septemberRecords,
  skuMaster,
  TODAY,
} from './fixtures/dataset.ts';

function ctxFor(records: { date: string; raw: Record<string, number | string> }[]) {
  return {
    // 一行一天 —— 与源文件行一一对应（重复日期才算"重复导入"）
    allDates: [...new Set(records.map((r) => r.date))],
    declaredColumns: allColumns(),
    parsedColumns: Object.keys(records[0]?.raw ?? {}),
    skuMaster: skuMaster(),
    observedSkus: [] as string[],
    market: 'cn' as const,
  };
}

describe('DQ 闸门', () => {
  it('健康的 9 月数据：无 block、无 warn，且通过', () => {
    const records = septemberRecords();
    const report = runDq(groupDays(records), ctxFor(records), `${TODAY}T09:00:00Z`);

    expect(report.passed).toBe(true);
    expect(report.blockCount).toBe(0);
    expect(report.warnCount).toBe(0);
    expect(report.rulesRun).toBe(11);
  });

  it('复刻 7 月事故：多计 ¥6,391 必须被 block 拦住', () => {
    const records = julyIncidentRecords();
    const report = runDq(groupDays(records), ctxFor(records), '2026-07-16T09:00:00Z');

    expect(report.passed).toBe(false);

    const expense = report.findings.find((f) => f.ruleId === 'EXPENSE_EQUALS_PARTS');
    expect(expense).toBeDefined();
    expect(expense?.severity).toBe('block');
    // diff 约定 = actual − expected = 申报 5,000 − 平台合计 11,391
    expect(expense?.diff).toBeCloseTo(-6_391, 2);
    expect(expense?.actual).toBeCloseTo(5_000, 2);
    expect(expense?.expected).toBeCloseTo(11_391, 2);

    const netRule = report.findings.find((f) => f.ruleId === 'NET_EQUALS_REV_MINUS_EXP');
    expect(netRule).toBeDefined();
    expect(netRule?.diff).toBeCloseTo(6_391, 2);
    expect(netRule?.actual).toBeCloseTo(75_000, 2);
    expect(netRule?.expected).toBeCloseTo(68_609, 2);

    // 漏掉的「总退款」列也必须被列漂移规则发现
    expect(report.findings.some((f) => f.ruleId === 'COLUMN_DRIFT')).toBe(true);
  });

  it('block 优先排序，且报告文案含定位与金额', () => {
    const records = julyIncidentRecords();
    const report = runDq(groupDays(records), ctxFor(records), '2026-07-16T09:00:00Z');
    const text = formatDqReport(report);

    expect(report.findings[0]?.severity).toBe('block');
    expect(text).toContain('已阻止发布');
    expect(text).toContain('6,391.00');
    expect(text).toContain('2026-07-15');
  });

  it('已知差异可留痕，但仍计为 block（不静默放行）', () => {
    const records = julyIncidentRecords();
    const report = runDq(
      groupDays(records),
      {
        ...ctxFor(records),
        acknowledged: { 'EXPENSE_EQUALS_PARTS|2026-07-15': '已与平台对账，为平台延迟结算，7/20 补录' },
      },
      '2026-07-16T09:00:00Z',
    );
    const f = report.findings.find((x) => x.ruleId === 'EXPENSE_EQUALS_PARTS');
    expect(f?.acknowledged).toContain('7/20 补录');
    expect(report.passed).toBe(false);
  });

  it('售价越界触发 warn，不阻断发布', () => {
    const records = [
      ...septemberRecords(),
      ...buildDay('2026-09-11', { taobao: [90_000, 0, 200, 6] }),
    ];
    const report = runDq(groupDays(records), ctxFor(records), `${TODAY}T09:00:00Z`);
    const price = report.findings.filter((f) => f.ruleId === 'PRICE_IN_RANGE');
    expect(price.length).toBeGreaterThan(0);
    expect(price.every((f) => f.severity === 'warn')).toBe(true);
    expect(report.passed).toBe(true);
  });

  it('未映射商品名进入待匹配队列（warn）', () => {
    const records = septemberRecords();
    const report = runDq(
      groupDays(records),
      { ...ctxFor(records), observedSkus: ['不在场50ml', '外星人香水50ml'] },
      `${TODAY}T09:00:00Z`,
    );
    const unmapped = report.findings.filter((f) => f.ruleId === 'SKU_UNMAPPED');
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]?.scope).toBe('外星人香水50ml');
  });

  it('日期缺口被 block（会扭曲月达成率）', () => {
    const records = septemberRecords().filter((r) => r.date !== '2026-09-05');
    const report = runDq(groupDays(records), ctxFor(records), `${TODAY}T09:00:00Z`);
    expect(report.findings.some((f) => f.ruleId === 'DATE_CONTINUITY')).toBe(true);
  });
});

describe('DQ 汇总', () => {
  it('按规则聚合计数', () => {
    const records = julyIncidentRecords();
    const report = runDq(groupDays(records), ctxFor(records), '2026-07-16T09:00:00Z');
    const rows = summarizeByRule(report);
    expect(rows.every((r) => r.count >= 1)).toBe(true);
    expect(rows.reduce((a, r) => a + r.count, 0)).toBe(report.findings.length);
  });
});
