/**
 * L6 · ui/format —— 展示格式（**不在前端重写一份**）
 *
 * 内核 model/format 已经定义了唯一口径（CLI 报告、质量中心、看板卡片必须一致）。
 * 这里只做两件事：
 *   1. 转出内核的格式化函数，供视图直接使用；
 *   2. 补一个负数金额的排版修正（内核产出 `¥-100.00`，人眼更习惯 `-¥100.00`）。
 */

import {
  formatDelta,
  formatInt,
  formatMoney,
  formatPct,
  formatRatio,
} from '@origo/core';

export { formatDelta, formatInt, formatPct, formatRatio };
export const formatPctOf = formatPct;

/** 金额：¥1,234.56 / -¥1,234.56 */
export function money(v: number, decimals: 0 | 2 = 2): string {
  if (!Number.isFinite(v)) return '—';
  return v < 0 ? `-${formatMoney(-v, decimals)}` : formatMoney(v, decimals);
}

/** 紧凑金额，用于图表轴与卡片副文案：¥1.5万 */
export function moneyShort(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 100_000_000) return `${sign}¥${(a / 100_000_000).toFixed(2)}亿`;
  if (a >= 10_000) return `${sign}¥${(a / 10_000).toFixed(2)}万`;
  if (a >= 1_000) return `${sign}¥${(a / 1_000).toFixed(1)}千`;
  return `${sign}¥${a.toFixed(0)}`;
}

/** 天数的中文表达：null → — */
export function days(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(1)} 天`;
}

/** 整数（无数字时为 —） */
export function num(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return formatInt(v);
}

/** ROI 分档 → 中文标签 */
export function roiZoneLabel(zone: 'safe' | 'warning' | 'loss' | 'unknown' | undefined): string {
  switch (zone) {
    case 'safe':
      return '安全区（≥1.5）';
    case 'warning':
      return '保本线上（1–1.5）';
    case 'loss':
      return '亏损区（<1）';
    default:
      return '数据不足';
  }
}
