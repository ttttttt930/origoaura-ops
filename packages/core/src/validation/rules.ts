/**
 * L5 · validation/rules —— 声明式数据质量规则（SAD §5.2）
 *
 * 为什么是架构级而非页面小功能（SAD §5.1）：
 *   7 月事故（漏退款列、少计 ¥6,391）的本质是**错误数据被无校验地写进了可信链路**。
 *   因此校验是管道中的强制闸门，并与内核同源 —— block 则管道退出非零、不产出快照。
 *
 * 规则分两类，与 SAD 的接口形状一致但做了必要扩展（已在下文注明）：
 *   - 逐日规则 DAY_RULES：签名 check(day, ctx)，操作单位是 NormalizedDay
 *   - 数据集规则 DATASET_RULES：管连续性/列漂移/SKU 映射，天然无法逐日判定
 */

import type { NormalizedDay } from '../model/daily.ts';
import type { SkuMaster } from '../model/sku.ts';
import type { DqFinding, DqSeverity } from '../model/snapshot.ts';

/** 规则执行上下文 */
export interface DqContext {
  days: readonly NormalizedDay[];
  /** 所有观测到的日期（含重复），用于连续性与重复校验 */
  allDates: readonly string[];
  /** 解析配置里声明的列 */
  declaredColumns: readonly string[];
  /** 实际在文件里遇到的列 */
  parsedColumns: readonly string[];
  /**
   * 由各平台**推导**而非源自文件的规范列（如分组表头布局下没有「总退款」列）。
   * 这些列缺席是设计使然，不算列漂移，但也不会因此获得"已勾稽"的豁免。
   */
  derivedColumns?: readonly string[];
  /** SKU 主数据 */
  skuMaster: readonly SkuMaster[];
  /** 观测到的商品名（来自 SKU×日 数据；无该维度时为空） */
  observedSkus: readonly string[];
  /**
   * 单元格格式问题统计（各适配器汇总）。
   * coerced = 文本型数字被无歧义解析（如 "1,291.44"）；invalid = 彻底解析不了。
   * 这类问题会悄悄把金额变成 0，必须报 warn 让人知道。
   */
  cellIssues?: readonly { scope: string; coerced: number; invalid: number; samples: string[] }[];
  /** 市场，用于单价合理区间（国内 / 跨境） */
  market: 'cn' | 'overseas';
  /** 已知差异备注（ruleId+scope → 备注），留痕不静默（SAD §5.3） */
  acknowledged?: Record<string, string>;
}

/** 逐日规则 */
export interface DqRule {
  id: string;
  severity: DqSeverity;
  title: string;
  /** 命中则返回 finding 数组（不含 ruleId/severity/message，由执行器补齐）；未命中返回 null */
  check(day: NormalizedDay, ctx: DqContext): Omit<DqFinding, 'ruleId' | 'severity' | 'message'>[] | null;
  /** 生成人话 message */
  message(f: Omit<DqFinding, 'ruleId' | 'severity' | 'message'>): string;
}

/** 数据集规则 */
export interface DqDatasetRule {
  id: string;
  severity: DqSeverity;
  title: string;
  check(ctx: DqContext): Omit<DqFinding, 'ruleId' | 'severity' | 'message'>[] | null;
  message(f: Omit<DqFinding, 'ruleId' | 'severity' | 'message'>): string;
}

/** 容差：max(¥1, 2%) —— SAD §5.2 EXPENSE_EQUALS_PARTS 明确要求 */
export function tolerance(expected: number): number {
  return Math.max(1, Math.abs(expected) * 0.02);
}

function money(v: number): string {
  return `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ------------------------------------------------------------------ *
 * 逐日规则
 * ------------------------------------------------------------------ */

/** 1. 总支出 = Σ平台(推广 + 退款) —— block（7 月事故的那条） */
const EXPENSE_EQUALS_PARTS: DqRule = {
  id: 'EXPENSE_EQUALS_PARTS',
  severity: 'block',
  title: '总支出 = Σ平台(推广+退款)',
  check(day) {
    // 与「原表申报的总支出」比对；两个申报列都缺失时无可比对，跳过
    const declaredPromo = day.declared?.promotion;
    const declaredRefund = day.declared?.refund;
    const declaredExpense = day.declared?.expense;
    if (declaredPromo === undefined && declaredRefund === undefined && declaredExpense === undefined) {
      return null;
    }
    const parts = round2(day.platforms.reduce((a, p) => a + p.promotion + p.refund, 0));
    // 优先用申报的「总支出」，否则用申报的推广+退款
    const actual =
      declaredExpense !== undefined
        ? declaredExpense
        : round2((declaredPromo ?? 0) + (declaredRefund ?? 0));
    const diff = round2(actual - parts);
    if (Math.abs(diff) <= tolerance(parts)) return null;
    return [{ scope: day.date, expected: parts, actual, diff }];
  },
  message: (f) =>
    `${f.scope} 总支出与各平台合计不符：原表申报 ${money(f.actual)}，` +
    `Σ平台(推广+退款) ${money(f.expected)}，差 ${money(f.diff)}。` +
    `常见原因：平台列漏配（如 7 月漏退款列）或公式被改动。`,
};

/** 2. 净收入 = 收入 − 退款 − 推广 —— block（针对"申报口径"的自洽性） */
const NET_EQUALS_REV_MINUS_EXP: DqRule = {
  id: 'NET_EQUALS_REV_MINUS_EXP',
  severity: 'block',
  title: '净收入 = 收入 − 退款 − 推广',
  check(day) {
    const d = day.declared;
    if (!d || d.net === undefined) return null;
    // 三个分项缺失时用平台推导值兜底，保证规则依然可判定
    const revenue = d.revenue ?? day.total.revenue;
    const refund = d.refund ?? day.total.refund;
    const promotion = d.promotion ?? day.total.promotion;
    const expected = round2(revenue - refund - promotion);
    const actual = d.net;
    const diff = round2(actual - expected);
    if (Math.abs(diff) <= tolerance(expected)) return null;
    return [{ scope: day.date, expected, actual, diff }];
  },
  message: (f) =>
    `${f.scope} 净收入与「收入 − 退款 − 推广」不符：原表 ${money(f.actual)}，` +
    `重算 ${money(f.expected)}，差 ${money(f.diff)}。` +
    `典型症状：净收入公式漏减退款（7 月多计 ¥6,391 即为该原因）。`,
};

/** 3. 平台合计 = 总计行列 —— block */
const PLATFORM_SUM_EQUALS_TOTAL: DqRule = {
  id: 'PLATFORM_SUM_EQUALS_TOTAL',
  severity: 'block',
  title: '平台合计 = 总计行',
  check(day) {
    const d = day.declared;
    if (!d) return null;
    const out: Omit<DqFinding, 'ruleId' | 'severity' | 'message'>[] = [];
    const pairs: [string, number | undefined, number][] = [
      ['总收入', d.revenue, day.total.revenue],
      ['总退款', d.refund, day.total.refund],
      ['总推广支出', d.promotion, day.total.promotion],
      ['总销量', d.qty, day.total.qty],
    ];
    for (const [col, declared, summed] of pairs) {
      if (declared === undefined) continue; // 原表没有该总计列：由平台行推导，无需比对
      const diff = round2(declared - summed);
      if (Math.abs(diff) > tolerance(summed)) {
        out.push({ scope: `${day.date}/${col}`, expected: summed, actual: declared, diff });
      }
    }
    return out.length ? out : null;
  },
  message: (f) =>
    `${f.scope.split('/')[0]} 的「${f.scope.split('/')[1]}」与各平台相加不符：` +
    `总计 ${money(f.actual)}，平台合计 ${money(f.expected)}，差 ${money(f.diff)}。`,
};

/** 4a. 销量非负 —— block */
const NONNEG_QTY: DqRule = {
  id: 'NONNEG_QTY',
  severity: 'block',
  title: '销量非负',
  check(day) {
    const bad = day.platforms.filter((p) => p.qty < 0);
    if (!bad.length) return null;
    return bad.map((p) => ({
      scope: `${day.date}/${p.platform}`,
      expected: 0,
      actual: p.qty,
      diff: p.qty,
    }));
  },
  message: (f) => `${f.scope} 销量为负（${f.actual}），数据异常。`,
};

/** 4b. 退款 ≤ 收入 —— block */
const REFUND_LE_REVENUE: DqRule = {
  id: 'REFUND_LE_REVENUE',
  severity: 'block',
  title: '退款 ≤ 收入',
  check(day) {
    const bad = day.platforms.filter((p) => p.refund > p.revenue + tolerance(p.revenue));
    if (!bad.length) return null;
    return bad.map((p) => ({
      scope: `${day.date}/${p.platform}`,
      expected: p.revenue,
      actual: p.refund,
      diff: round2(p.refund - p.revenue),
    }));
  },
  message: (f) =>
    `${f.scope} 退款 ${money(f.actual)} 超过收入 ${money(f.expected)}，疑似列错位或重复计。`,
};

/** 5. 单价合理区间 ¥30–500 —— warn（跨境香水可另行配置） */
const PRICE_IN_RANGE: DqRule = {
  id: 'PRICE_IN_RANGE',
  severity: 'warn',
  title: '单价区间 ¥30–500',
  check(day, ctx) {
    const [lo, hi] = ctx.market === 'overseas' ? [80, 1200] : [30, 500];
    const out: Omit<DqFinding, 'ruleId' | 'severity' | 'message'>[] = [];
    for (const p of day.platforms) {
      if (p.qty <= 0 || p.revenue <= 0) continue;
      const unit = p.revenue / p.qty;
      if (unit < lo || unit > hi) {
        out.push({
          scope: `${day.date}/${p.platform}`,
          expected: (lo + hi) / 2,
          actual: round2(unit),
          diff: round2(unit - (lo + hi) / 2),
        });
      }
    }
    return out.length ? out : null;
  },
  message: (f) =>
    `${f.scope} 成交均价 ${money(f.actual)} 落在合理区间外，疑似单位错误（元/件）或异常订单。`,
};

/* ------------------------------------------------------------------ *
 * 数据集规则（无法逐日判定）
 * ------------------------------------------------------------------ */

/** 6a. 日期连续性 —— block */
const DATE_CONTINUITY: DqDatasetRule = {
  id: 'DATE_CONTINUITY',
  severity: 'block',
  title: '日期连续无缺口',
  check(ctx) {
    const dates = [...new Set(ctx.allDates)].sort();
    if (dates.length < 2) return null;
    const missing: string[] = [];
    const start = new Date(`${dates[0]}T00:00:00Z`);
    const end = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
    for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (!dates.includes(d)) missing.push(d);
    }
    if (!missing.length) return null;
    return [
      {
        scope: `${dates[0]}~${dates[dates.length - 1]}`,
        expected: 0,
        actual: missing.length,
        diff: missing.length,
      },
    ];
  },
  message: (f) =>
    `${f.scope} 区间内缺失 ${f.actual} 天数据（缺口天数非 0）。缺数据会直接扭曲月度达成率与环比，请补齐后再发布。`,
};

/** 6b. 日期不重复 —— warn（重复导入会双计） */
const NO_DUP_DATE: DqDatasetRule = {
  id: 'NO_DUP_DATE',
  severity: 'warn',
  title: '日期不重复',
  check(ctx) {
    const seen = new Map<string, number>();
    for (const d of ctx.allDates) seen.set(d, (seen.get(d) ?? 0) + 1);
    const dups = [...seen.entries()].filter(([, n]) => n > 1);
    if (!dups.length) return null;
    return dups.map(([date, n]) => ({
      scope: date,
      expected: 1,
      actual: n,
      diff: n - 1,
    }));
  },
  message: (f) => `${f.scope} 出现 ${f.actual} 次，重复导入会导致双计。`,
};

/** 7. 列漂移：解析到未知列或缺失声明列 —— block（C4/ADR-04） */
const COLUMN_DRIFT: DqDatasetRule = {
  id: 'COLUMN_DRIFT',
  severity: 'block',
  title: '列结构与映射一致',
  check(ctx) {
    const declared = new Set(ctx.declaredColumns);
    const parsed = new Set(ctx.parsedColumns);
    const derived = new Set(ctx.derivedColumns ?? []);
    const unknown = ctx.parsedColumns.filter(
      (c) => !declared.has(c) && !/^(date|日期|备注|备注列|备注说明)$/.test(c),
    );
    const missing = ctx.declaredColumns.filter((c) => {
      if (parsed.has(c)) return false; // 已解析到
      if (derived.has(c)) return false; // 设计上就是推导列，缺席不是问题
      // C4：历史月份可能整体没有某平台，允许缺失，交由 platformCount 体现
      if (/^(拼多多|小红书|tiktok)/.test(c)) return false;
      return true;
    });
    const out: Omit<DqFinding, 'ruleId' | 'severity' | 'message'>[] = [];
    if (unknown.length) {
      out.push({ scope: `未知列：${unknown.join('、')}`, expected: 0, actual: unknown.length, diff: unknown.length });
    }
    if (missing.length) {
      out.push({ scope: `缺失列：${missing.join('、')}`, expected: 0, actual: missing.length, diff: missing.length });
    }
    return out.length ? out : null;
  },
  message: (f) =>
    `${f.scope}。平台改版时只需更新 data/master/column-mappings/ 下的映射配置，不要改内核。`,
};

/** 8. 商品名未映射到主数据 —— warn，进入待匹配队列 */
const SKU_UNMAPPED: DqDatasetRule = {
  id: 'SKU_UNMAPPED',
  severity: 'warn',
  title: '商品名已映射到 SKU 主数据',
  check(ctx) {
    if (!ctx.observedSkus.length) return null;
    const known = new Set(ctx.skuMaster.map((s) => normalizeName(s.sku)));
    const unknown = ctx.observedSkus.filter((s) => !known.has(normalizeName(s)));
    if (!unknown.length) return null;
    return unknown.map((sku) => ({ scope: sku, expected: 1, actual: 0, diff: -1 }));
  },
  message: (f) => `商品「${f.scope}」在主数据中找不到对应 SKU，已进入待匹配队列（该 SKU 暂不参与毛利计算）。`,
};

/** 归一化商品名：去空白、去全角括号差异，用于模糊匹配 */
export function normalizeName(s: string): string {
  return s
    .replace(/[\s　]/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .toLowerCase();
}

/** 9. 单元格格式：文本型数字 / 无法解析的值 —— warn */
const CELL_FORMAT: DqDatasetRule = {
  id: 'CELL_FORMAT',
  severity: 'warn',
  title: '数值单元格格式规范',
  check(ctx) {
    const issues = ctx.cellIssues ?? [];
    const out: Omit<DqFinding, 'ruleId' | 'severity' | 'message'>[] = [];
    for (const i of issues) {
      if (i.coerced === 0 && i.invalid === 0) continue;
      out.push({ scope: i.scope, expected: 0, actual: i.coerced + i.invalid, diff: i.coerced + i.invalid });
      out[out.length - 1]!.scope = `${i.scope}|${i.samples.slice(0, 3).join(' ')}`;
    }
    return out.length ? out : null;
  },
  message: (f) => {
    const [scope, samples] = f.scope.split('|');
    return (
      `${scope} 有 ${f.actual} 个数值单元格是文本格式（示例：${samples ?? '—'}）。` +
      `已按数值解析，但建议把源表这些列改为数值格式 —— 文本型数字一旦带上无法解析的字符就会被静默当成 0。`
    );
  },
};

/* ------------------------------------------------------------------ *
 * 注册表
 * ------------------------------------------------------------------ */

export const DAY_RULES: readonly DqRule[] = [
  EXPENSE_EQUALS_PARTS,
  NET_EQUALS_REV_MINUS_EXP,
  PLATFORM_SUM_EQUALS_TOTAL,
  NONNEG_QTY,
  REFUND_LE_REVENUE,
  PRICE_IN_RANGE,
];

export const DATASET_RULES: readonly DqDatasetRule[] = [
  DATE_CONTINUITY,
  NO_DUP_DATE,
  COLUMN_DRIFT,
  SKU_UNMAPPED,
  CELL_FORMAT,
];

export const ALL_RULE_IDS: readonly string[] = [
  ...DAY_RULES.map((r) => r.id),
  ...DATASET_RULES.map((r) => r.id),
];

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
