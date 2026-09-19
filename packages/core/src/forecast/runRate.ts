/**
 * L5 · forecast/runRate —— 跑率外推（PRD G3 早报 / 驾驶舱"整月预估"的同源算法）
 *
 * 方法论（与 aggregate.ts 的部分月预估保持同一套口径，避免两处算法漂移）：
 *   日均 = 已过天数的实际合计 / 已过天数
 *   预估 = 日均 × 当期自然天数
 *   置信度 = 已过天数 / 当期自然天数（天数越少，外推越不可信 → 界面必须标注）
 *
 * 铁律：外推值永远是**估算**，返回值里带 `confidence` 与 `estimated:true`，
 * 界面必须打「估算」角标（C7）。绝不把外推值混入"实际"数字里。
 */

import type { DailyRecord, ISODate } from '../model/daily.ts';
import type { SkuMaster } from '../model/sku.ts';
import { blendedUnitCost, type PeriodMetrics } from '../compute/aggregate.ts';
import { round2 } from '../model/daily.ts';

export interface RunRateOptions {
  /** 观测基准日 */
  today: ISODate;
  /** 'month' | 'year' */
  scope?: 'month' | 'year';
}

export interface RunRateResult {
  scope: 'month' | 'year';
  periodStart: ISODate;
  periodEnd: ISODate;
  /** 已过天数（有数据的天数） */
  observedDays: number;
  periodDays: number;
  /** 已实现（实际） */
  actual: Pick<PeriodMetrics, 'gmv' | 'qty' | 'materialCost' | 'promotion' | 'realProfit' | 'cashback'>;
  /** 外推的整期值（估算） */
  projected: Pick<PeriodMetrics, 'gmv' | 'qty' | 'materialCost' | 'promotion' | 'realProfit' | 'cashback'> & {
    /** 剩余天数 */
    remainingDays: number;
  };
  /** 置信度 0–1：已过天数占比 */
  confidence: number;
  /** 置信度分档文案 */
  confidenceLabel: '低' | '中' | '高';
  /** 是否在外推中（未走完） */
  estimated: true;
}

function daysInMonth(y: number, m1: number): number {
  return new Date(Date.UTC(y, m1, 0)).getUTCDate();
}

export function runRate(
  records: readonly DailyRecord[],
  skuMaster: readonly SkuMaster[],
  opts: RunRateOptions,
): RunRateResult {
  const scope = opts.scope ?? 'month';
  const today = opts.today;

  let periodStart: ISODate;
  let periodEnd: ISODate;
  let periodDays: number;

  if (scope === 'month') {
    const ym = today.slice(0, 7);
    const [y, m] = ym.split('-').map(Number) as [number, number];
    periodDays = daysInMonth(y, m);
    periodStart = `${ym}-01`;
    periodEnd = `${ym}-${String(periodDays).padStart(2, '0')}`;
  } else {
    const y = Number(today.slice(0, 4));
    periodStart = `${y}-01-01`;
    periodEnd = `${y}-12-31`;
    periodDays = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
  }

  const rows = records.filter((r) => r.date >= periodStart && r.date <= periodEnd);
  const observedDays = new Set(rows.map((r) => r.date)).size;

  const gmv = round2(rows.reduce((a, r) => a + r.revenue, 0));
  const qty = rows.reduce((a, r) => a + r.qty, 0);
  const promotion = round2(rows.reduce((a, r) => a + r.promotion, 0));

  const { value: unitCost } = blendedUnitCost(skuMaster);
  const materialCost = round2(unitCost * qty);

  const actual = {
    gmv,
    qty,
    materialCost,
    promotion,
    realProfit: round2(gmv - materialCost - promotion),
    cashback: round2(gmv - promotion - rows.reduce((a, r) => a + r.refund, 0)),
  };

  const safeObserved = observedDays > 0 ? observedDays : 1;
  const factor = observedDays > 0 ? periodDays / safeObserved : 0;
  const remainingDays = Math.max(0, periodDays - observedDays);

  const projected = {
    gmv: round2(actual.gmv * factor),
    qty: Math.round(actual.qty * factor),
    materialCost: round2(actual.materialCost * factor),
    promotion: round2(actual.promotion * factor),
    realProfit: round2(actual.realProfit * factor),
    cashback: round2(actual.cashback * factor),
    remainingDays,
  };

  const confidence = Math.min(1, observedDays / periodDays);
  const confidenceLabel: RunRateResult['confidenceLabel'] =
    observedDays === 0 ? '低' : confidence >= 0.7 ? '高' : confidence >= 0.35 ? '中' : '低';

  return {
    scope,
    periodStart,
    periodEnd,
    observedDays,
    periodDays,
    actual,
    projected,
    confidence: Math.round(confidence * 100) / 100,
    confidenceLabel,
    estimated: true,
  };
}
