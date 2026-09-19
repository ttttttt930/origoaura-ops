/**
 * L4 · adapters/excelDaily —— 「营销发展日报.xlsx」→ DailyRecord[]
 *
 * 关键行为（对齐 SAD §4.1 与 C4）：
 *   · 一行原始数据 = 一天；内核里再炸成「平台行」，但 raw 保留完整 31 列；
 *   · 某平台整块列不存在（如 1–6 月没有拼多多）→ **不产出行**，而不是补 0，
 *     否则「平台数」「均价」「渠道占比」都会被假的 0 污染；
 *   · 净收入一律由 core.makeDailyRecord 重算，绝不读原表净收入列。
 */

import {
  CANONICAL_COLUMNS,
  PLATFORMS,
  PLATFORM_LABEL,
  makeDailyRecord,
  safeNumber,
  type DailyRecord,
  type Platform,
} from '@origo/core';
import { loadColumnMapping, resolveMapping, type ColumnMapping } from './columnMapping.ts';
import { normalizeHeader, readSheet, type RawRow } from './xlsx.ts';

export interface DailyIngestResult {
  records: DailyRecord[];
  /** 规范列视角的已解析列（供 DQ 比对） */
  parsedColumns: string[];
  declaredColumns: string[];
  /** 每个源行一个日期（重复日期 = 重复导入） */
  allDates: string[];
  /** 源文件行数 */
  rowCount: number;
  notes: string[];
  source: string;
}

export interface DailyIngestOptions {
  profile?: string;
  sheet?: string;
  /** 覆盖映射（测试 / 特殊批次用） */
  mapping?: ColumnMapping;
}

/** Excel 序列号 → ISO 日期（1900 系统，含闰年 bug 修正） */
export function excelSerialToISO(serial: number): string {
  const ms = Math.round((serial - 25_569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

/** 把任意日期单元格解析成 'YYYY-MM-DD'；无法解析返回 null（不猜） */
export function parseDateCell(v: unknown, fmt: 'auto' | 'excel-serial' | 'iso' = 'auto'): string | null {
  if (v === null || v === undefined || v === '') return null;

  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }

  if (typeof v === 'number' && Number.isFinite(v)) {
    if (fmt === 'iso') return null;
    // Excel 序列号合理区间：2000-01-01 ~ 2100-01-01
    if (v > 36_000 && v < 73_000) return excelSerialToISO(v);
    return null;
  }

  const s = String(v).trim();
  const m = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  const numeric = Number(s);
  if (Number.isFinite(numeric) && numeric > 36_000 && numeric < 73_000) return excelSerialToISO(numeric);
  return null;
}

/** 从原始行里取出该平台在本文件中"是否有列" */
function platformPresent(resolved: Map<string, string>, platform: Platform): boolean {
  return resolved.has(`${PLATFORM_LABEL[platform]}收入`);
}

/** 把一条原始行转成该日的平台行 */
function rowToRecords(
  row: RawRow,
  resolved: Map<string, string>,
  date: string,
  source: string,
): DailyRecord[] {
  // 先把 31 列按规范列名提取成 raw（审计口径永远是规范列名）
  const raw: Record<string, number | string> = {};
  for (const col of CANONICAL_COLUMNS) {
    const src = resolved.get(col);
    if (src === undefined) continue;
    const v = row[src];
    raw[col] = typeof v === 'number' ? v : String(v ?? '');
  }

  const out: DailyRecord[] = [];
  for (const p of PLATFORMS) {
    // C4：该平台整块列不存在 → 这一天就不产这个平台的行
    if (!platformPresent(resolved, p)) continue;
    const label = PLATFORM_LABEL[p];
    out.push(
      makeDailyRecord({
        date,
        platform: p,
        revenue: safeNumber(raw[`${label}收入`]),
        refund: safeNumber(raw[`${label}退款`]),
        promotion: safeNumber(raw[`${label}推广支出`]),
        qty: safeNumber(raw[`${label}销量`]),
        raw,
        source,
      }),
    );
  }
  return out;
}

/** 读一个日报文件 */
export function ingestDaily(filePath: string, opts: DailyIngestOptions = {}): DailyIngestResult {
  const load = opts.mapping
    ? { mapping: opts.mapping, found: true, notes: [] as string[] }
    : loadColumnMapping(opts.profile ?? 'default');
  const mapping = load.mapping;

  const sheet = readSheet(filePath, opts.sheet ?? mapping.sheet);
  const headers = sheet.headers.map(normalizeHeader);
  // 归一化后的表头 → 原始表头，便于回取单元格
  const headerMap = new Map<string, string>();
  sheet.headers.forEach((h, i) => headerMap.set(headers[i]!, h));

  const resolved = resolveMapping(mapping, headers);
  const notes = [...load.notes, ...resolved.notes];

  const dateSrcKey = mapping.dateColumns.map(normalizeHeader).find((c) => headers.includes(c));
  if (!dateSrcKey) {
    throw new Error(
      `在 ${filePath} 中找不到日期列（尝试过：${mapping.dateColumns.join('、')}）。` +
        `请在 data/master/column-mappings/${mapping.profile}.json 的 dateColumns 里补充实际列名。`,
    );
  }
  const dateHeader = headerMap.get(dateSrcKey)!;

  const records: DailyRecord[] = [];
  const allDates: string[] = [];
  let skipped = 0;

  for (const row of sheet.rows) {
    const date = parseDateCell(row[dateHeader], mapping.dateFormat ?? 'auto');
    if (!date) {
      skipped += 1;
      continue;
    }
    allDates.push(date);
    records.push(...rowToRecords(row, resolved.byCanonical, date, filePath));
  }

  if (skipped) notes.push(`有 ${skipped} 行的日期无法解析，已跳过（不会静默当成当天）。`);

  return {
    records,
    parsedColumns: resolved.parsedColumns,
    declaredColumns: [...CANONICAL_COLUMNS],
    allDates,
    rowCount: sheet.rows.length,
    notes,
    source: filePath,
  };
}
