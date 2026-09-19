/**
 * L4 · adapters/xlsx —— SheetJS 互操作薄层
 *
 * 存在的唯一理由：xlsx 是 CJS 包，在 ESM + 类型擦除的运行方式下，
 * `import * as` 拿到的是命名空间还是 default 取决于 cjs-module-lexer 的探测结果。
 * 与其在两处各写一遍兜底，不如收敛成一个入口。
 */

import * as NS from 'xlsx';

type XlsxModule = typeof NS;

const mod: XlsxModule =
  (NS as unknown as { default?: XlsxModule }).default ?? NS;

export const XLSX = mod;

/** 一行原始数据（表头 → 单元格值） */
export type RawRow = Record<string, unknown>;

export interface SheetData {
  sheetName: string;
  headers: string[];
  rows: RawRow[];
}

/**
 * 读第一个（或指定）工作表为对象数组。
 * `defval: ''` 保证空缺单元格也有键，避免"列时有时无"导致的映射漂移。
 */
export function readSheet(filePath: string, sheetName?: string): SheetData {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const name = sheetName ?? wb.SheetNames[0];
  if (!name) throw new Error(`文件 ${filePath} 里没有任何工作表`);
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`文件 ${filePath} 里找不到工作表「${name}」`);

  const rows = XLSX.utils.sheet_to_json<RawRow>(ws, { defval: '', raw: true });
  const headers = rows.length
    ? Object.keys(rows[0] as RawRow)
    : (XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, range: 0 })[0] ?? []);

  return { sheetName: name, headers, rows };
}

/** 列出所有工作表名 */
export function listSheets(filePath: string): string[] {
  return XLSX.readFile(filePath, { bookSheets: true }).SheetNames;
}

export interface MergeRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export interface SheetMatrix {
  sheetName: string;
  /** 原始二维数组（含空单元格），保留分组表头所需的物理位置 */
  rows: unknown[][];
  /** 合并单元格范围 —— 分组表头的权威依据 */
  merges: MergeRange[];
}

/**
 * 以「二维数组 + 合并信息」读表。
 * 分组表头（总览 / 淘宝 / 抖音 …）必须靠位置与合并范围还原，
 * 用对象数组（sheet_to_json + header）会直接丢失这层信息。
 */
export function readSheetMatrix(filePath: string, sheetName: string): SheetMatrix {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    throw new Error(`找不到工作表「${sheetName}」（可用：${wb.SheetNames.join('、')}）`);
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { defval: '', raw: true, header: 1 });
  const merges = (ws['!merges'] ?? []) as MergeRange[];
  return { sheetName, rows, merges };
}

/** 单元格转字符串（trim），空值归一为 '' */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\s　]/g, '').trim();
}

/** 把任意表头单元格规范成字符串键（去空白、统一全角括号） */
export function normalizeHeader(h: unknown): string {
  return String(h ?? '')
    .replace(/[\s　]/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .trim();
}
