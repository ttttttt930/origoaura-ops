/**
 * L4 · adapters/dailyMonthly —— 「N月汇总」分组表头布局（**本项目真实布局**）
 *
 * 实测结构（以 2026-09 的「9月汇总」为例）：
 *
 *        c0     c1..c3                 c4..c8              c9..c13    …   c24..c28
 *   第0行  日期   [总览]                 [淘宝]              [抖音]     …   [tiktok]
 *   第1行        收入 支出 净收1          当日收入 当日退款 …   当日收入 …
 *
 * 关键事实（这些直接决定了 DQ 能不能抓到 7 月事故）：
 *   1. 「总览」块只有 **收入 / 支出 / 净收1** 三列 —— 没有独立的退款列。
 *      「支出」是 Excel 里的公式（应为「退款+推广」）。7 月事故就是这条公式少加了退款，
 *      却被当成可信数据一路带到了看板。故 总览/支出 必须作为**申报值**原样保留，
 *      交給 core 的 EXPENSE_EQUALS_PARTS 去和「Σ各平台(退款+推广)」勾稽。
 *   2. 「总退款 / 总推广支出 / 总销量」在源文件里**根本不存在**，只能由各平台推导。
 *      这类列必须显式声明为 derivedColumns，否则列漂移规则会误报。
 *   3. 平台分组是合并单元格，宽度 5；但存在"标签未合并/偏移"的历史脏格式
 *      （如 1月汇总的 tiktok 标签落在 c21，它的数据却在 c19..c23）。
 *      因此分组边界**以第 1 行的「当日收入」为准**，平台名再按顺序对应，
 *      不能依赖合并范围，也不能依赖标签所在列。
 *   4. 平台数量随月份演进：1–6 月 4 个（无拼多多），7 月起 5 个（C4）。
 */

import {
  CANONICAL_COLUMNS,
  PLATFORMS,
  PLATFORM_LABEL,
  makeDailyRecord,
  parseNumeric,
  round2,
  type DailyRecord,
  type Platform,
} from '@origo/core';
import { loadColumnMapping } from './columnMapping.ts';
import { cellText, listSheets, readSheetMatrix } from './xlsx.ts';
import { parseDateCell } from './excelDaily.ts';

/** 分组表头布局的解析配置（可由 column-mappings 覆盖） */
export interface GroupedLayoutConfig {
  /** 参与解析的月份工作表名正则 */
  monthSheetPattern: string;
  /** 总览块名（不当作平台） */
  overviewGroup: string;
  /** 日期列所在的分组名 */
  dateGroup: string;
  /** 平台分组起始的指标名（用于定位分组边界） */
  groupStartMetric: string;
  /** 总览块的指标别名 */
  overviewMetrics: { revenue: string[]; expense: string[]; net: string[] };
  /** 平台分组内的指标别名 */
  platformMetrics: {
    revenue: string[];
    refund: string[];
    promotion: string[];
    net: string[];
    qty: string[];
  };
  /** 源文件中不存在的规范列（只能推导） */
  derivedColumns: string[];
  /** 表头所在行号（0 起）：分组名行 / 指标名行 */
  groupRow: number;
  metricRow: number;
}

export const DEFAULT_GROUPED_LAYOUT: GroupedLayoutConfig = {
  monthSheetPattern: '^\\d+月汇总$',
  overviewGroup: '总览',
  dateGroup: '日期',
  groupStartMetric: '当日收入',
  overviewMetrics: {
    revenue: ['收入'],
    expense: ['支出'],
    net: ['净收1', '净收入', '净收'],
  },
  platformMetrics: {
    revenue: ['当日收入', '收入'],
    refund: ['当日退款', '退款'],
    promotion: ['当日推广', '当日推广/支出', '当日推广支出', '推广'],
    net: ['日净收入', '当日净收入', '净收入'],
    qty: ['当日销量', '销量'],
  },
  derivedColumns: ['总退款', '总推广支出', '总销量'],
  groupRow: 0,
  metricRow: 1,
};

export interface MonthlyIngestResult {
  records: DailyRecord[];
  /** 成功填充的**规范列**（供 DQ 的列漂移比对） */
  parsedColumns: string[];
  declaredColumns: string[];
  derivedColumns: string[];
  allDates: string[];
  rowCount: number;
  notes: string[];
  source: string;
  /** 参与解析的月份工作表 */
  sheets: string[];
  /** 每个平台在源文件里出现过多少个工作日表（用于确认 C4 演进） */
  platformSheetCount: Record<string, number>;
  /** 单元格格式问题（文本型数字 / 无法解析），交给 DQ 报 warn */
  cellIssues: { scope: string; coerced: number; invalid: number; samples: string[] }[];
}

/** 一个分组块：列范围 + 名称 */
export interface ColumnGroup {
  name: string;
  start: number;
  end: number;
}

/**
 * 从两行表头还原出分组块。
 * 分组边界以 `metricRow` 上 `groupStartMetric` 的出现位置为准。
 */
export function parseGroupedHeader(
  rows: readonly unknown[][],
  cfg: GroupedLayoutConfig,
): { groups: ColumnGroup[]; dateCol: number; overview: ColumnGroup | null; notes: string[] } {
  const groupRow = rows[cfg.groupRow] ?? [];
  const metricRow = rows[cfg.metricRow] ?? [];
  const width = Math.max(groupRow.length, metricRow.length);
  const notes: string[] = [];

  // 1) 找日期列：分组名为「日期」的首列
  let dateCol = -1;
  for (let c = 0; c < width; c += 1) {
    if (cellText(groupRow[c]) === cfg.dateGroup) {
      dateCol = c;
      break;
    }
  }
  if (dateCol < 0) throw new Error('分组表头里找不到「日期」列');

  // 2) 平台/总览分组边界：指标名 == groupStartMetric 的位置
  const starts: number[] = [];
  for (let c = 0; c < width; c += 1) {
    if (cellText(metricRow[c]) === cfg.groupStartMetric) starts.push(c);
  }
  if (!starts.length) {
    throw new Error(
      `在指标行找不到分组起始指标「${cfg.groupStartMetric}」，无法确定平台分组边界。` +
        `若平台改版了指标名，请更新 column-mappings 的 groupStartMetric。`,
    );
  }

  // 3) 总览块 = 日期列之后、第一个平台分组之前的列
  const overviewStart = dateCol + 1;
  const overviewEnd = starts[0]! - 1;
  const overview: ColumnGroup | null =
    overviewEnd >= overviewStart ? { name: cfg.overviewGroup, start: overviewStart, end: overviewEnd } : null;

  // 4) 分组名按**顺序**对应（标签可能未合并 / 位置偏移，不依赖物理列）
  const labels: string[] = [];
  for (let c = 0; c < width; c += 1) {
    const name = cellText(groupRow[c]);
    if (!name || name === cfg.dateGroup || name === cfg.overviewGroup) continue;
    labels.push(name);
  }

  const groups: ColumnGroup[] = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]! - 1 : Math.max(...[metricRow.length, groupRow.length]) - 1;
    return { name: labels[i] ?? `未知分组${i + 1}`, start, end };
  });

  if (labels.length !== starts.length) {
    notes.push(
      `分组标签数（${labels.length}）与分组边界数（${starts.length}）不一致，已按顺序尽量对应。` +
        `请核对表头是否被改动：标签 [${labels.join('、')}]。`,
    );
  }

  return { groups, dateCol, overview, notes };
}

/** 在分组块内按指标别名找列号 */
function findMetricCol(
  rows: readonly unknown[][],
  metricRowIdx: number,
  group: ColumnGroup,
  aliases: readonly string[],
): number {
  const metricRow = rows[metricRowIdx] ?? [];
  for (const alias of aliases) {
    for (let c = group.start; c <= group.end; c += 1) {
      if (cellText(metricRow[c]) === alias) return c;
    }
  }
  return -1;
}

/** 平台名 → Platform（支持 tiktok 等英文标签） */
function toPlatform(label: string): Platform | null {
  const t = label.trim().toLowerCase();
  for (const p of PLATFORMS) {
    if (PLATFORM_LABEL[p].toLowerCase() === t) return p;
  }
  if (t === '天猫' || t === '淘宝天猫') return 'taobao';
  if (t === '抖音小店') return 'douyin';
  if (t === '小红书店') return 'xiaohongshu';
  if (t === '拼夕夕') return 'pdd';
  return null;
}

export interface MonthlyIngestOptions {
  /** 列映射配置名（用于取 column-mappings 提示） */
  profile?: string;
  /** 只解析这些工作表；缺省按 monthSheetPattern 自动选 */
  sheets?: string[];
  layout?: Partial<GroupedLayoutConfig>;
}

/** 判断一个工作簿是否为分组月度布局 */
export function detectGroupedLayout(filePath: string): boolean {
  try {
    const names = listSheets(filePath);
    const monthSheets = names.filter((n) => new RegExp(DEFAULT_GROUPED_LAYOUT.monthSheetPattern).test(n));
    if (!monthSheets.length) return false;
    const { rows } = readSheetMatrix(filePath, monthSheets[0]!);
    const metricRow = rows[DEFAULT_GROUPED_LAYOUT.metricRow] ?? [];
    return metricRow.some((v) => cellText(v) === DEFAULT_GROUPED_LAYOUT.groupStartMetric);
  } catch {
    return false;
  }
}

/** 解析分组月度布局的工作簿 */
export function ingestDailyMonthly(
  filePath: string,
  opts: MonthlyIngestOptions = {},
): MonthlyIngestResult {
  const mappingLoad = loadColumnMapping(opts.profile ?? 'default');
  const cfg: GroupedLayoutConfig = { ...DEFAULT_GROUPED_LAYOUT, ...opts.layout };
  const notes: string[] = [...mappingLoad.notes];

  const allSheetNames = listSheets(filePath);
  const monthRe = new RegExp(cfg.monthSheetPattern);
  const sheets = opts.sheets ?? allSheetNames.filter((n) => monthRe.test(n));
  if (!sheets.length) {
    throw new Error(
      `没有找到符合「${cfg.monthSheetPattern}」的工作表（可用：${allSheetNames.join('、')}）。`,
    );
  }

  const records: DailyRecord[] = [];
  const allDates: string[] = [];
  const platformSheetCount: Record<string, number> = {};
  const filledCanonical = new Set<string>();
  const cellIssues: MonthlyIngestResult['cellIssues'] = [];
  let rowCount = 0;

  for (const sheetName of sheets) {
    const { rows } = readSheetMatrix(filePath, sheetName);
    const header = parseGroupedHeader(rows, cfg);
    notes.push(...header.notes.map((n) => `[${sheetName}] ${n}`));

    // 该表的单元格格式统计（文本型数字是这个工作簿的实际问题：7 月整月收入被粘成文本）
    const issue = { scope: sheetName, coerced: 0, invalid: 0, samples: [] as string[] };
    const readNum = (v: unknown): number => {
      const p = parseNumeric(v);
      if (p.status === 'coerced') {
        issue.coerced += 1;
        if (issue.samples.length < 5) issue.samples.push(`"${p.raw}"`);
      } else if (p.status === 'invalid') {
        issue.invalid += 1;
        if (issue.samples.length < 5) issue.samples.push(`?${p.raw}`);
      }
      return p.value;
    };

    // 总览块列号
    const overviewCols = header.overview
      ? {
          revenue: findMetricCol(rows, cfg.metricRow, header.overview, cfg.overviewMetrics.revenue),
          expense: findMetricCol(rows, cfg.metricRow, header.overview, cfg.overviewMetrics.expense),
          net: findMetricCol(rows, cfg.metricRow, header.overview, cfg.overviewMetrics.net),
        }
      : { revenue: -1, expense: -1, net: -1 };
    if (overviewCols.revenue < 0) {
      notes.push(`[${sheetName}] 总览块没有收入列，总收入将退回由各平台求和。`);
    }
    if (overviewCols.expense < 0) {
      notes.push(
        `[${sheetName}] 总览块没有「支出」列：EXPENSE_EQUALS_PARTS 无法勾稽该月，` +
          `这会让"少计退款"这类问题失去防线，请补回该列。`,
      );
    }

    // 平台分组
    const platformGroups: { platform: Platform; group: ColumnGroup }[] = [];
    for (const g of header.groups) {
      const p = toPlatform(g.name);
      if (!p) {
        notes.push(`[${sheetName}] 未识别的分组「${g.name}」，已跳过（不计入任何平台）。`);
        continue;
      }
      platformGroups.push({ platform: p, group: g });
      platformSheetCount[PLATFORM_LABEL[p]] = (platformSheetCount[PLATFORM_LABEL[p]] ?? 0) + 1;
    }

    const startRow = cfg.metricRow + 1;
    for (let r = startRow; r < rows.length; r += 1) {
      const row = rows[r] ?? [];
      const date = parseDateCell(row[header.dateCol], 'auto');
      if (!date) continue; // 空行 / 合计行 / 说明行一律跳过，不猜
      rowCount += 1;
      allDates.push(date);

      // ---- 申报值：只放源文件里**真实存在**的列 ----
      const raw: Record<string, number | string> = {};
      if (overviewCols.revenue >= 0) raw['总收入'] = readNum(row[overviewCols.revenue]);
      if (overviewCols.expense >= 0) raw['总支出'] = readNum(row[overviewCols.expense]);
      if (overviewCols.net >= 0) raw['净收入'] = readNum(row[overviewCols.net]);

      for (const { platform, group } of platformGroups) {
        const label = PLATFORM_LABEL[platform];
        const cols = {
          revenue: findMetricCol(rows, cfg.metricRow, group, cfg.platformMetrics.revenue),
          refund: findMetricCol(rows, cfg.metricRow, group, cfg.platformMetrics.refund),
          promotion: findMetricCol(rows, cfg.metricRow, group, cfg.platformMetrics.promotion),
          net: findMetricCol(rows, cfg.metricRow, group, cfg.platformMetrics.net),
          qty: findMetricCol(rows, cfg.metricRow, group, cfg.platformMetrics.qty),
        };
        const revenue = cols.revenue >= 0 ? readNum(row[cols.revenue]) : 0;
        const refund = cols.refund >= 0 ? readNum(row[cols.refund]) : 0;
        const promotion = cols.promotion >= 0 ? readNum(row[cols.promotion]) : 0;
        const qty = cols.qty >= 0 ? readNum(row[cols.qty]) : 0;

        raw[`${label}收入`] = revenue;
        raw[`${label}退款`] = refund;
        raw[`${label}推广支出`] = promotion;
        // 源文件里的「日净收入」是申报值，可能同样被改坏 —— 保留原值供审计，
        // 业务计算一律用 core 重算的 net（makeDailyRecord 已保证）。
        if (cols.net >= 0) raw[`${label}净收入`] = readNum(row[cols.net]);
        raw[`${label}销量`] = qty;

        records.push(
          makeDailyRecord({
            date,
            platform,
            revenue,
            refund,
            promotion,
            qty,
            raw,
            source: `${filePath}#${sheetName}`,
          }),
        );
      }

      for (const key of Object.keys(raw)) if (CANONICAL_COLUMNS.includes(key as never)) filledCanonical.add(key);
    }

    if (issue.coerced || issue.invalid) {
      cellIssues.push(issue);
      notes.push(
        `[${sheetName}] 检测到文本型数字 ${issue.coerced} 个、无法解析 ${issue.invalid} 个` +
          `（示例：${issue.samples.slice(0, 3).join(' ')}）。已按数值解析，建议在源表改为数值格式。`,
      );
    }
  }

  if (rowCount === 0) notes.push('没有解析到任何数据行：请确认表头行号与日期列是否正确。');

  return {
    records,
    parsedColumns: [...filledCanonical],
    declaredColumns: [...CANONICAL_COLUMNS],
    derivedColumns: cfg.derivedColumns,
    allDates,
    rowCount,
    notes,
    source: filePath,
    sheets,
    platformSheetCount,
    cellIssues,
  };
}

/** 便捷导出：某日各平台合计（自检用） */
export function dayTotalOf(records: readonly DailyRecord[], date: string): {
  revenue: number;
  refund: number;
  promotion: number;
} {
  const rows = records.filter((r) => r.date === date);
  return {
    revenue: round2(rows.reduce((a, r) => a + r.revenue, 0)),
    refund: round2(rows.reduce((a, r) => a + r.refund, 0)),
    promotion: round2(rows.reduce((a, r) => a + r.promotion, 0)),
  };
}
