/**
 * L5 · compute/aggregate —— 周期窗口与聚合（迁移 v6 已修正口径，SAD §8）
 *
 * 五档时间口径，与 V9 驾驶舱一一对应：
 *   today 当天
 *   week  **滚动近 7 天 vs 前 7 天**（不是 ISO 自然周 —— v6 修正：周一查看自然周只有 1 天、
 *         却和上周 7 天比，严重失真）
 *   month 当月；当月未走完时双口径：已过 X/总天数 + 整月预估（按日均外推，打「估算」角标），
 *         且同比必须用「上月同长度日」切片对齐，禁止整月 vs 部分月
 *   year  本年（1/1 起）
 *   all   全期
 *
 * 本文件零 IO、零 DOM、不取当前时间（"今天"由调用方注入），保证可测。
 */

import type { DailyRecord, ISODate, TotalRecord } from '../model/daily.ts';
import { round2 } from '../model/daily.ts';
import type { SkuMaster } from '../model/sku.ts';

export type PeriodKind = 'today' | 'week' | 'month' | 'year' | 'all';

export const PERIOD_KINDS: readonly PeriodKind[] = ['today', 'week', 'month', 'year', 'all'];

export interface PeriodWindow {
  kind: PeriodKind;
  start: ISODate;
  end: ISODate;
  /**
   * 窗口内**有实际数据**的天数。
   *
   * 注意口径：不是"源表里有行"，而是"营收/退款/推广/销量任一非 0"。
   * 实测源表会把整月模板行预填好（9 月 11–30 日各列为 0），
   * 若按"有行"计数，9 月会被误判成"已走完的整月" ——
   * 于是既不出「整月预估」角标，日均还被 30 天稀释（真实只有 10 天有数）。
   * 这是与 7 月事故同源的"静默口径漂移"，故在核心里定义一次。
   */
  observedDays: number;
  /** 窗口内日历天数（含端点） */
  calendarDays: number;
  /** 日历天数 − 有数据天数：源表预填的模板空行 / 真实停业日 */
  blankDays: number;
  /** 展示用标签，如 '2026-09-01 ~ 2026-09-10（10天）' */
  label: string;
  /** 当月未走完 */
  isPartialMonth: boolean;
  /** 仅 month 档：已过天数（= 本月有数据的天数） */
  monthDaysSoFar?: number;
  /** 仅 month 档：自然月总天数 */
  monthDaysTotal?: number;
  /** 整月预估放大系数 = 总天数 / 已有数据天数 */
  projFactor?: number;
  /** 仅 month 档：本月最后一个**有数据**的日期（用于"数据截至"提示） */
  lastActiveDate?: ISODate;
}

export interface PeriodPair {
  /** 当前窗口 */
  current: PeriodWindow;
  /** 对比窗口（同长度）；all 档为 null */
  previous: PeriodWindow | null;
  /** 对比文案前缀，如 'vs 昨日' / 'vs 上周' / 'vs 上月同期' / 'vs 去年' */
  compareLabel: string;
}

export interface PeriodMetrics {
  gmv: number;
  refund: number;
  promotion: number;
  net: number;
  qty: number;
  /** 物料成本（按综合单瓶成本 × 销量） */
  materialCost: number;
  /** 真实净利 = gmv − materialCost − promotion */
  realProfit: number;
  /** 平均 ROI = gmv / promotion（无推广时为 null） */
  roi: number | null;
  /** 真实 ROI = gmv / (materialCost + promotion) */
  realRoi: number | null;
  /** 现金回款 = gmv − promotion − refund */
  cashback: number;
  refundRate: number;
  promoRate: number;
  /** 客单价 = gmv / qty（无销量时为 0） */
  aov: number;
  dailyAvgGmv: number;
  /** 综合单瓶物料成本是否为估算值（无 SKU 实际数据时为 true，界面须打角标） */
  unitCostEstimated: boolean;
  /** 整月预估（仅 partial month 有值） */
  projected?: {
    gmv: number;
    realProfit: number;
    cashback: number;
    qty: number;
    /** 放大的物料成本（整月口径） */
    materialCost: number;
  };
}

export interface PeriodResult {
  window: PeriodWindow;
  metrics: PeriodMetrics;
  /** 对比窗口指标；无对比时为 null */
  previousMetrics: PeriodMetrics | null;
  /** 环比/同比增幅（%）；无对比或基期为 0 时为 null */
  delta: number | null;
}

const DAY_MS = 86_400_000;

function toDate(iso: ISODate): Date {
  return new Date(`${iso}T00:00:00Z`);
}
function toIso(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}
function addDays(iso: ISODate, n: number): ISODate {
  return toIso(new Date(toDate(iso).getTime() + n * DAY_MS));
}
function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}
/** 闭区间日历天数 */
function dayCount(start: ISODate, end: ISODate): number {
  return Math.round((toDate(end).getTime() - toDate(start).getTime()) / DAY_MS) + 1;
}

/** 综合单瓶物料成本 —— 有 estMonthlyQty 则按其加权，否则等权。始终标记为估算。 */
export function blendedUnitCost(skuMaster: readonly SkuMaster[]): {
  value: number;
  estimated: true;
  basis: 'weighted-by-est-qty' | 'equal-weight';
} {
  const active = skuMaster.filter((s) => s.status === 'active');
  if (!active.length) return { value: 0, estimated: true, basis: 'equal-weight' };
  const totalQty = active.reduce((a, s) => a + (s.estMonthlyQty ?? 0), 0);
  if (totalQty > 0) {
    const v = active.reduce((a, s) => a + s.unitCost * (s.estMonthlyQty ?? 0), 0) / totalQty;
    return { value: round2(v), estimated: true, basis: 'weighted-by-est-qty' };
  }
  const v = active.reduce((a, s) => a + s.unitCost, 0) / active.length;
  return { value: round2(v), estimated: true, basis: 'equal-weight' };
}

/** 按日期升序排列的**全部**日期列表（含模板空行） */
function sortedDates(records: readonly DailyRecord[]): ISODate[] {
  return [...new Set(records.map((r) => r.date))].sort();
}

/**
 * "有数据"的日期集合 —— 营收/退款/推广/销量任一非 0。
 * 用于把源表预填的整月模板空行排除在"已过天数"之外（见 PeriodWindow.observedDays）。
 */
function activeDateSet(records: readonly DailyRecord[]): Set<ISODate> {
  const set = new Set<ISODate>();
  for (const r of records) {
    if (r.revenue !== 0 || r.refund !== 0 || r.promotion !== 0 || r.qty !== 0) set.add(r.date);
  }
  return set;
}

/**
 * 构造周期窗口。
 * @param today 由调用方注入的"今天"（内核不取当前时间）
 */
export function buildWindow(
  kind: PeriodKind,
  records: readonly DailyRecord[],
  today: ISODate,
): PeriodWindow {
  const dates = sortedDates(records);
  const active = activeDateSet(records);
  // 数据边界取"有数据"的首尾 —— 末尾的模板空行不应被当作数据终点
  const activeDates = dates.filter((d) => active.has(d));
  const dataStart = activeDates[0] ?? today;
  const dataEnd = activeDates[activeDates.length - 1] ?? today;

  const span = (start: ISODate, end: ISODate): PeriodWindow => {
    const inRange = dates.filter((d) => d >= start && d <= end);
    const observed = inRange.filter((d) => active.has(d)).length;
    const calendarDays = dayCount(start, end);
    const blankDays = Math.max(0, calendarDays - observed);
    return {
      kind,
      start,
      end,
      observedDays: observed,
      calendarDays,
      blankDays,
      label:
        start === end
          ? `${start}`
          : blankDays > 0
            ? `${start} ~ ${end}（有数据 ${observed}/${calendarDays} 天）`
            : `${start} ~ ${end}（${observed}天）`,
      isPartialMonth: false,
    };
  };

  switch (kind) {
    case 'today':
      return span(today, today);

    case 'week': {
      // 滚动近 7 天：以"今天/最后一个有数据的日期"中较早者为锚，
      // 这样补数后依然能看到完整一周。
      const anchor = dataEnd < today ? dataEnd : today;
      return span(addDays(anchor, -6), anchor);
    }

    case 'month': {
      const ym = today.slice(0, 7);
      const [y, m] = ym.split('-').map(Number) as [number, number];
      const total = daysInMonth(y, m);
      const start = `${ym}-01`;
      const end = `${ym}-${String(total).padStart(2, '0')}`;
      const activeInMonth = dates.filter((d) => d.startsWith(ym) && active.has(d));
      const observed = activeInMonth.length;
      const isCurrentMonth = observed > 0 && observed < total;
      const w = span(start, end);
      w.isPartialMonth = isCurrentMonth;
      w.monthDaysSoFar = observed;
      w.monthDaysTotal = total;
      w.projFactor = isCurrentMonth && observed > 0 ? total / observed : 1;
      w.lastActiveDate = activeInMonth[activeInMonth.length - 1];
      if (isCurrentMonth) {
        w.label = `${start} ~ ${w.lastActiveDate ?? today}（有数据 ${observed}/${total} 天）`;
      }
      return w;
    }

    case 'year': {
      const y = today.slice(0, 4);
      return span(`${y}-01-01`, `${y}-12-31`);
    }

    case 'all':
      return span(dataStart, dataEnd);
  }
}

/**
 * 构造「当前 + 对比」窗口对。
 * 对比口径严格对齐：today→昨日、week→前 7 天、month→上月同长度日、year→去年、all→无
 */
export function buildPeriodPair(
  kind: PeriodKind,
  records: readonly DailyRecord[],
  today: ISODate,
): PeriodPair {
  const current = buildWindow(kind, records, today);
  const set = activeDateSet(records);
  const dates = sortedDates(records).filter((d) => set.has(d));

  switch (kind) {
    case 'today': {
      const prevDay = addDays(today, -1);
      return { current, previous: windowFromExisting(prevDay, prevDay, dates), compareLabel: 'vs 昨日' };
    }
    case 'week': {
      const anchor = current.end;
      return {
        current,
        previous: windowFromExisting(addDays(anchor, -13), addDays(anchor, -7), dates),
        compareLabel: 'vs 上周',
      };
    }
    case 'month': {
      // 上月同日区间：严格同长度（slice(0, 同长度日)），禁止整月 vs 部分月
      const [y, m] = current.start.split('-').map(Number) as [number, number];
      const prevY = m === 1 ? y - 1 : y;
      const prevM = m === 1 ? 12 : m - 1;
      const prevTotal = daysInMonth(prevY, prevM);
      const len = current.isPartialMonth ? (current.monthDaysSoFar ?? 0) : daysInMonth(y, m);
      const startDay = 1;
      const endDay = Math.min(len, prevTotal);
      const p = `${prevY}-${String(prevM).padStart(2, '0')}`;
      return {
        current,
        previous: windowFromExisting(
          `${p}-${String(startDay).padStart(2, '0')}`,
          `${p}-${String(endDay).padStart(2, '0')}`,
          dates,
        ),
        compareLabel: current.isPartialMonth ? 'vs 上月同期' : 'vs 上月',
      };
    }
    case 'year': {
      const y = Number(current.start.slice(0, 4));
      const p = `${y - 1}-01-01`;
      const pe = `${y - 1}-${current.end.slice(5)}`;
      return { current, previous: windowFromExisting(p, pe, dates), compareLabel: 'vs 去年' };
    }
    case 'all':
      return { current, previous: null, compareLabel: '' };
  }
}

function windowFromExisting(start: ISODate, end: ISODate, activeDates: readonly ISODate[]): PeriodWindow {
  const observed = activeDates.filter((d) => d >= start && d <= end).length;
  const calendarDays = dayCount(start, end);
  const blankDays = Math.max(0, calendarDays - observed);
  return {
    kind: 'today',
    start,
    end,
    observedDays: observed,
    calendarDays,
    blankDays,
    label: start === end ? start : `${start} ~ ${end}（${observed}天）`,
    isPartialMonth: false,
  };
}

/**
 * 在窗口内聚合指标。
 * @param allRecords 全量记录（函数内部按窗口切片，避免调用方切片出错）
 */
export function aggregate(
  allRecords: readonly DailyRecord[],
  window: PeriodWindow,
  skuMaster: readonly SkuMaster[],
): PeriodMetrics {
  const rows = allRecords.filter((r) => r.date >= window.start && r.date <= window.end);
  const t = sumRows(rows);

  const { value: unitCost, estimated } = blendedUnitCost(skuMaster);
  const materialCost = round2(unitCost * t.qty);
  const realProfit = round2(t.revenue - materialCost - t.promotion);
  const cashback = round2(t.revenue - t.promotion - t.refund);
  const roi = t.promotion > 0 ? round2(t.revenue / t.promotion) : null;
  const denom = materialCost + t.promotion;
  const realRoi = denom > 0 ? round2(t.revenue / denom) : null;

  const observed = window.observedDays || 1;

  const metrics: PeriodMetrics = {
    gmv: t.revenue,
    refund: t.refund,
    promotion: t.promotion,
    net: t.net,
    qty: t.qty,
    materialCost,
    realProfit,
    roi,
    realRoi,
    cashback,
    refundRate: t.revenue > 0 ? round2((t.refund / t.revenue) * 100) : 0,
    promoRate: t.revenue > 0 ? round2((t.promotion / t.revenue) * 100) : 0,
    aov: t.qty > 0 ? round2(t.revenue / t.qty) : 0,
    dailyAvgGmv: round2(t.revenue / observed),
    unitCostEstimated: estimated,
  };

  // 部分月：给出整月预估（按已过天数日均外推，界面打「估算」角标）
  if (window.isPartialMonth && window.projFactor && window.projFactor > 1) {
    const f = window.projFactor;
    metrics.projected = {
      gmv: round2(t.revenue * f),
      realProfit: round2(realProfit * f),
      cashback: round2(cashback * f),
      qty: Math.round(t.qty * f),
      materialCost: round2(materialCost * f),
    };
  }

  return metrics;
}

/** 聚合一个周期对（当前 + 对比），并算出增幅 */
export function aggregatePeriod(
  allRecords: readonly DailyRecord[],
  kind: PeriodKind,
  today: ISODate,
  skuMaster: readonly SkuMaster[],
): PeriodResult {
  const pair = buildPeriodPair(kind, allRecords, today);
  const metrics = aggregate(allRecords, pair.current, skuMaster);
  const previousMetrics = pair.previous ? aggregate(allRecords, pair.previous, skuMaster) : null;
  let delta: number | null = null;
  if (previousMetrics && previousMetrics.gmv > 0) {
    delta = round2(((metrics.gmv - previousMetrics.gmv) / previousMetrics.gmv) * 100);
  }
  return { window: pair.current, metrics, previousMetrics, delta };
}

function sumRows(rows: readonly DailyRecord[]): TotalRecord {
  let revenue = 0;
  let refund = 0;
  let promotion = 0;
  let net = 0;
  let qty = 0;
  for (const r of rows) {
    revenue += r.revenue;
    refund += r.refund;
    promotion += r.promotion;
    net += r.net;
    qty += r.qty;
  }
  return {
    date: '',
    revenue: round2(revenue),
    refund: round2(refund),
    promotion: round2(promotion),
    net: round2(net),
    qty: round2(qty),
    platformCount: 0,
  };
}

/** Hero 卡片（表现层直接渲染，不得自行计算） */
export interface HeroCard {
  key: 'gmv' | 'realProfit' | 'cashback' | 'realRoi';
  title: string;
  value: number | null;
  unit: 'currency' | 'ratio';
  delta: number | null;
  compareLabel: string;
  /** 真实 ROI 的安全区判定 */
  zone?: 'safe' | 'warning' | 'loss';
  sub: string;
}

/**
 * 四档"看板上常用"的快照指标，供 Hero 卡片直接消费。
 * 组件不得自己算这些 —— 只能在 core 里定义一次（SAD §8）。
 */
export function heroCards(result: PeriodResult): HeroCard[] {
  const { metrics: m, window: w, delta, previousMetrics } = result;
  const money = (v: number) => `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const partial = w.isPartialMonth;

  const roiZone: HeroCard['zone'] =
    m.realRoi === null ? undefined : m.realRoi >= 1.5 ? 'safe' : m.realRoi >= 1 ? 'warning' : 'loss';
  const roiZoneText =
    roiZone === 'safe' ? '高于安全线 1.5' : roiZone === 'warning' ? '保本线上、安全线以下' : '低于 1，亏损';

  const cards: HeroCard[] = [
    {
      key: 'gmv',
      title: partial ? `月营收 截至 ${w.monthDaysSoFar}/${w.monthDaysTotal}天` : '营收',
      value: m.gmv,
      unit: 'currency',
      delta: previousMetrics ? delta : null,
      compareLabel: w.kind === 'all' ? '' : compareLabelOf(w.kind),
      sub: partial && m.projected ? `整月预估 ${money(m.projected.gmv)} · 估算` : `日均 ${money(m.dailyAvgGmv)}`,
    },
    {
      key: 'realProfit',
      title: '真实净利',
      value: m.realProfit,
      unit: 'currency',
      delta: null,
      compareLabel: '',
      sub: `营收 ${money(m.gmv)} − 物料 ${money(m.materialCost)} − 推广 ${money(m.promotion)}`,
    },
    {
      key: 'cashback',
      title: '现金回款',
      value: m.cashback,
      unit: 'currency',
      delta: null,
      compareLabel: '',
      sub: `退款 ${money(m.refund)} · 退款率 ${m.refundRate}%`,
    },
    {
      key: 'realRoi',
      title: '真实 ROI',
      value: m.realRoi,
      unit: 'ratio',
      delta: null,
      compareLabel: '',
      zone: roiZone,
      sub: m.realRoi === null ? '暂无推广/成本数据' : roiZoneText,
    },
  ];
  return cards;
}

function compareLabelOf(kind: PeriodKind): string {
  return { today: 'vs 昨日', week: 'vs 上周', month: 'vs 上月同期', year: 'vs 去年', all: '' }[kind];
}
