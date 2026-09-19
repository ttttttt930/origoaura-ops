/**
 * 日期解析回归 —— 锁死「Excel 序列号日期整体少一天」这个事故。
 *
 * 事故回放：2/3/4/5 月汇总的日期列是 Excel 序列号（46081…），
 * SheetJS 以 `cellDates: true` 读出的是**本地时区**且带亚秒漂移的 Date
 * （2026-02-28 会变成 `2026-02-27T23:59:17+08:00`）。
 * 旧的 parseDateCell 直接 `v.toISOString().slice(0,10)`，
 * 漂移先退一天、+08:00 转 UTC 再退一天 → 整批日期集体少一天，
 * 表现为「5 月 31 日缺失」+「2026-01-31 重复」两个假故障。
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { excelSerialToISO, localDateToISO, parseDateCell } from '../src/adapters/excelDaily.ts';
import { readSheetMatrix } from '../src/adapters/xlsx.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_XLSX = resolve(HERE, '../../../data/raw/营销发展日报.xlsx');
const HAS_RAW = existsSync(RAW_XLSX);

describe('excelSerialToISO', () => {
  it('2026 年各月首末日的序列号映射正确（独立基准：1970-01-01 = 25569）', () => {
    expect(excelSerialToISO(46023)).toBe('2026-01-01');
    expect(excelSerialToISO(46054)).toBe('2026-02-01');
    expect(excelSerialToISO(46081)).toBe('2026-02-28');
    expect(excelSerialToISO(46082)).toBe('2026-03-01');
    expect(excelSerialToISO(46173)).toBe('2026-05-31');
    expect(excelSerialToISO(46174)).toBe('2026-06-01');
  });

  it('区间外的序列号不猜（返回 null）', () => {
    expect(parseDateCell(100)).toBeNull();
    expect(parseDateCell(999_999)).toBeNull();
  });
});

describe('localDateToISO', () => {
  it('本地午夜不会被时区拉回前一天', () => {
    expect(localDateToISO(new Date(2026, 1, 28, 0, 0, 0))).toBe('2026-02-28');
    expect(localDateToISO(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01');
    expect(localDateToISO(new Date(2025, 11, 31, 0, 0, 0))).toBe('2025-12-31');
  });

  it('SheetJS 的亚秒漂移（23:59:17）会被进到正确的那一天', () => {
    // 实测：serial 46081 在 UTC+8 被 SheetJS 读成 Fri Feb 27 2026 23:59:17 GMT+0800
    expect(localDateToISO(new Date(2026, 1, 27, 23, 59, 17))).toBe('2026-02-28');
    // 反向：月末最后一天同样要稳
    expect(localDateToISO(new Date(2026, 4, 30, 23, 59, 17))).toBe('2026-05-31');
  });

  it('带时区偏移的 UTC 午夜也不会错', () => {
    // TZ=UTC 环境下 SheetJS 会给出 UTC 午夜
    expect(parseDateCell(new Date('2026-02-28T00:00:00Z'))).toBe('2026-02-28');
    expect(parseDateCell(new Date('2026-02-27T15:59:17Z'))).toBe('2026-02-28');
  });
});

describe('parseDateCell', () => {
  it('文本日期照常解析', () => {
    expect(parseDateCell('2026-01-31')).toBe('2026-01-31');
    expect(parseDateCell('2026/6/1')).toBe('2026-06-01');
    expect(parseDateCell('2026年9月7日')).toBe('2026-09-07');
  });

  it('数字序列号与文本日期解析结果一致', () => {
    // 同一天：1月汇总写文本、2月汇总写序列号，两者必须落在同一天
    expect(parseDateCell('2026-02-28')).toBe(parseDateCell(46081));
  });

  it('脏值返回 null，不猜', () => {
    expect(parseDateCell(null)).toBeNull();
    expect(parseDateCell('')).toBeNull();
    expect(parseDateCell('总计')).toBeNull();
    expect(parseDateCell(new Date('not-a-date'))).toBeNull();
  });
});

describe('真实源表：序列号月份不得整体位移', () => {
  // 源表不进 git（含供货商报价），缺文件时跳过而不是假装通过
  const cases: Array<[sheet: string, first: string, last: string]> = [
    ['2月汇总', '2026-02-01', '2026-02-28'],
    ['3月汇总', '2026-03-01', '2026-03-31'],
    ['4月汇总', '2026-04-01', '2026-04-30'],
    ['5月汇总', '2026-05-01', '2026-05-31'],
  ];

  for (const [sheet, first, last] of cases) {
    it.skipIf(!HAS_RAW)(`${sheet} 覆盖 ${first} ~ ${last}`, () => {
      const { rows } = readSheetMatrix(RAW_XLSX, sheet);
      const dates = rows
        .slice(2)
        .map((r) => parseDateCell(r[0]))
        .filter((d): d is string => typeof d === 'string')
        .sort();
      expect(dates[0]).toBe(first);
      expect(dates[dates.length - 1]).toBe(last);
    });
  }

  it.skipIf(!HAS_RAW)('全表日期不重不漏（1/1~9/30 连续）', () => {
    const sheets = ['1月汇总', '2月汇总', '3月汇总', '4月汇总', '5月汇总', '6月汇总', '7月汇总', '8月汇总', '9月汇总'];
    const all = new Set<string>();
    for (const s of sheets) {
      const { rows } = readSheetMatrix(RAW_XLSX, s);
      for (const r of rows.slice(2)) {
        const d = parseDateCell(r[0]);
        if (d) all.add(d);
      }
    }
    const dates = [...all].sort();
    expect(dates[0]).toBe('2026-01-01');
    expect(dates[dates.length - 1]).toBe('2026-09-30');
    // 2026-01-01 ~ 2026-09-30 共 273 天
    expect(dates.length).toBe(273);
  });
});
