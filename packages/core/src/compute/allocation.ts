/**
 * L5 · compute/allocation —— 推广费分摊（PRD B5）
 *
 * 为什么单独成层：推广费只有在拿到「单品投流」时才可直连，
 * 拿不到就必须**按规则分摊**，且必须让用户一眼看出「这是分摊值」。
 * 把分摊算法写在组件里 = 口径分裂（V9 教训），故上收到内核。
 *
 * 分摊三策略：
 *   direct     只对有 promotionDirect 的行直连；其余按 by-revenue 补
 *   by-revenue 按单品收入占比（默认，最贴近"投得多卖得多"）
 *   by-qty     按销量占比（适合低价高量品）
 *
 * 铁律：分摊结果 `allocated=true`，界面必须打「分摊」角标（C7）。
 */

import type { AllocationStrategy } from '../model/sku.ts';

export interface AllocationItem {
  /** 唯一键（通常 sku，或 sku+platform 复合） */
  key: string;
  revenue: number;
  qty: number;
  /** 已直连的单品投放额；有值时优先直连 */
  promotionDirect?: number;
}

export interface AllocationResult {
  key: string;
  /** 最终分摊到的推广费 */
  promotion: number;
  /** true = 分摊值（非直连），界面须标注 */
  allocated: boolean;
  /** 实际采用的依据 */
  basis: AllocationStrategy;
  /** 该行的权重（占比，0–1）；直连行为 1 */
  weight: number;
}

interface Internal {
  key: string;
  revenue: number;
  qty: number;
  direct?: number;
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * 把某个池子里的推广费分摊到各明细行。
 *
 * @param items     同池明细（同平台 × 同周期）
 * @param pool      该池的实际推广费总额（以明细里的直连之和为下限）
 * @param strategy  分摊策略
 */
export function allocatePromotion(
  items: readonly AllocationItem[],
  pool: number,
  strategy: AllocationStrategy = 'by-revenue',
): AllocationResult[] {
  if (!items.length) return [];

  const rows: Internal[] = items.map((i) => ({
    key: i.key,
    revenue: Math.max(0, i.revenue),
    qty: Math.max(0, i.qty),
    direct: i.promotionDirect,
  }));

  // 1) 直连部分先锁定
  let directSum = 0;
  for (const r of rows) {
    if (r.direct !== undefined && r.direct !== null && r.direct > 0) directSum += r.direct;
  }

  // 2) 剩余池子按策略分摊给**没有直连**的行
  const remaining = Math.max(0, round2(pool - directSum));
  const free = rows.filter((r) => !(r.direct !== undefined && r.direct !== null && r.direct > 0));

  const weightOf = (r: Internal): number =>
    strategy === 'by-qty' ? r.qty : strategy === 'by-revenue' ? r.revenue : r.revenue;
  const totalWeight = free.reduce((a, r) => a + weightOf(r), 0);

  const results: AllocationResult[] = rows.map((r) => {
    const hasDirect = r.direct !== undefined && r.direct !== null && r.direct > 0;
    if (hasDirect) {
      return { key: r.key, promotion: round2(r.direct as number), allocated: false, basis: 'direct', weight: 1 };
    }
    if (!totalWeight) {
      // 无任何权重可用（全部 0 收入/0 销量）：均摊，仍标注为分摊
      const share = free.length ? round2(remaining / free.length) : 0;
      return { key: r.key, promotion: share, allocated: true, basis: strategy, weight: free.length ? 1 / free.length : 0 };
    }
    const w = weightOf(r) / totalWeight;
    return { key: r.key, promotion: round2(remaining * w), allocated: true, basis: strategy, weight: round4(w) };
  });

  // 3) 尾差归给分摊额最大的那行，保证 Σ分摊 = 池子（可对账）
  const sum = round2(results.reduce((a, r) => a + r.promotion, 0));
  const diff = round2(pool - sum);
  if (Math.abs(diff) >= 0.01) {
    const target = results
      .filter((r) => r.allocated)
      .sort((a, b) => b.promotion - a.promotion)[0];
    if (target) target.promotion = round2(target.promotion + diff);
  }

  return results;
}

/** 计算某组明细的收入占比（渠道/单品结构分析用） */
export function shareBy(
  items: readonly { key: string; revenue: number; qty: number }[],
  by: 'revenue' | 'qty' = 'revenue',
): { key: string; value: number; share: number }[] {
  const pick = (i: { revenue: number; qty: number }) => (by === 'qty' ? i.qty : i.revenue);
  const total = items.reduce((a, i) => a + pick(i), 0);
  return items
    .map((i) => ({
      key: i.key,
      value: round2(pick(i)),
      share: total > 0 ? round4(pick(i) / total) : 0,
    }))
    .sort((a, b) => b.value - a.value);
}

function round4(v: number): number {
  return Math.round((v + Number.EPSILON) * 10000) / 10000;
}
