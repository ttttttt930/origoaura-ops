/**
 * L5 · model/format —— 展示格式（**只在这里定义一次**）
 *
 * 为什么格式也算内核职责：CLI 报告、质量中心、看板卡片若各写一份 toLocaleString，
 * 同一条数字在两处显示成 ¥1000 与 ¥1,000，用户会怀疑数据本身。
 */

const CN = 'zh-CN';

/** 金额：¥1,234.56（默认两位小数；KPI 卡片可传 0） */
export function formatMoney(v: number, decimals: 0 | 2 = 2): string {
  if (!Number.isFinite(v)) return '—';
  return `¥${v.toLocaleString(CN, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/** 百分比：12.34%（入参是百分数本身，不是小数） */
export function formatPct(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  return `${v.toLocaleString(CN, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}%`;
}

/** 倍率：1.53×（ROI 等） */
export function formatRatio(v: number | null, decimals = 2): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(decimals)}×`;
}

/** 件数：1,234 */
export function formatInt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString(CN, { maximumFractionDigits: 0 });
}

/** 带正负号的百分比，用于环比/同比 */
export function formatDelta(v: number | null, decimals = 1): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(decimals)}%`;
}
