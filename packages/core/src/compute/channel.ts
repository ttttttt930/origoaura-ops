/**
 * L5 · compute/channel —— 渠道（平台）维度聚合
 *
 * 解决 V9 渠道页的三个问题：
 *   1. 只展示绝对值，没有结构占比 → 无法回答"抖音占比是不是在涨"；
 *   2. 缺渠道集中度 → 单渠道依赖风险无提示；
 *   3. 平台口径"净收入"直接读原表 → 7 月事故同一根因。
 * 这里统一从 DailyRecord 重算，绝不读原始净收入列。
 */

import type { DailyRecord, Platform } from '../model/daily.ts';
import { PLATFORMS, PLATFORM_LABEL, round2 } from '../model/daily.ts';
import type { SkuMaster } from '../model/sku.ts';
import type { PeriodWindow } from './aggregate.ts';
import { blendedUnitCost } from './aggregate.ts';

export interface ChannelMetrics {
  platform: Platform;
  label: string;
  revenue: number;
  refund: number;
  promotion: number;
  /** 重算净收入 = revenue − refund − promotion */
  net: number;
  qty: number;
  aov: number;
  refundRate: number;
  promoRate: number;
  /** 毛 ROI = revenue / promotion */
  roi: number | null;
  /** 结构占比 */
  shareOfRevenue: number;
  shareOfQty: number;
  /** 物料成本（按综合单瓶成本估算） */
  materialCost: number;
  /** 真实净利 = revenue − materialCost − promotion */
  realProfit: number;
  /** 真实 ROI = revenue / (materialCost + promotion) */
  realRoi: number | null;
  /** 该渠道在该窗口是否有数据（C4：4→5 平台演进） */
  active: boolean;
}

export interface ChannelReport {
  channels: ChannelMetrics[];
  /** 赫芬达尔指数（0–1），>0.5 视为高度依赖单一渠道 */
  hhi: number;
  /** 集中度结论；null = 不足以判断 */
  concentration: { level: 'low' | 'medium' | 'high'; message: string } | null;
  totalRevenue: number;
  /** 该窗口内实际有数据的平台数 */
  activePlatforms: number;
}

function pct(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * 渠道分解。**所有非零平台都会出现**（active=false 用于展示"该渠道本期无数据"，
 * 而不是把缺数据的渠道悄悄隐藏成 0）。
 */
export function channelBreakdown(
  records: readonly DailyRecord[],
  window: PeriodWindow,
  skuMaster: readonly SkuMaster[],
  onlyActive = false,
): ChannelReport {
  const rows = records.filter((r) => r.date >= window.start && r.date <= window.end);
  const { value: unitCost } = blendedUnitCost(skuMaster);
  const totalRevenue = round2(rows.reduce((a, r) => a + r.revenue, 0));
  const totalQty = rows.reduce((a, r) => a + r.qty, 0);

  const channels: ChannelMetrics[] = PLATFORMS.filter((p) => {
    if (!onlyActive) return true;
    return rows.some((r) => r.platform === p);
  }).map((p) => {
    const rs = rows.filter((r) => r.platform === p);
    const revenue = round2(rs.reduce((a, r) => a + r.revenue, 0));
    const refund = round2(rs.reduce((a, r) => a + r.refund, 0));
    const promotion = round2(rs.reduce((a, r) => a + r.promotion, 0));
    const net = round2(revenue - refund - promotion);
    const qty = rs.reduce((a, r) => a + r.qty, 0);
    const materialCost = round2(unitCost * qty);
    const denom = materialCost + promotion;
    return {
      platform: p,
      label: PLATFORM_LABEL[p],
      revenue,
      refund,
      promotion,
      net,
      qty,
      aov: qty > 0 ? round2(revenue / qty) : 0,
      refundRate: revenue > 0 ? pct((refund / revenue) * 100) : 0,
      promoRate: revenue > 0 ? pct((promotion / revenue) * 100) : 0,
      roi: promotion > 0 ? round2(revenue / promotion) : null,
      shareOfRevenue: totalRevenue > 0 ? pct((revenue / totalRevenue) * 100) : 0,
      shareOfQty: totalQty > 0 ? pct((qty / totalQty) * 100) : 0,
      materialCost,
      realProfit: round2(revenue - materialCost - promotion),
      realRoi: denom > 0 ? round2(revenue / denom) : null,
      active: rs.length > 0,
    };
  });

  channels.sort((a, b) => b.revenue - a.revenue);

  const hhi = totalRevenue > 0 ? round2(channels.reduce((a, c) => a + (c.revenue / totalRevenue) ** 2, 0) * 100) / 100 : 0;
  const activePlatforms = channels.filter((c) => c.active).length;

  let concentration: ChannelReport['concentration'] = null;
  if (activePlatforms >= 1 && totalRevenue > 0) {
    const top = channels[0]!;
    const onlyOne = activePlatforms === 1;
    if (hhi >= 0.5) {
      concentration = {
        level: 'high',
        message: onlyOne
          ? `本期只有 ${top.label} 有数据，营收 100% 依赖单一渠道（HHI 1）。请确认其余渠道是「尚未开通」还是「数据未导入」；若确实只做单渠道，需重点防范平台政策与流量波动风险。`
          : `${top.label} 贡献 ${top.shareOfRevenue}% 营收，渠道高度集中（HHI ${hhi}）。单渠道政策/流量波动将直接冲击整体营收，建议加速第二渠道起量。`,
      };
    } else if (hhi >= 0.25) {
      concentration = {
        level: 'medium',
        message: `最大渠道 ${top.label} 占 ${top.shareOfRevenue}%，集中度中等（HHI ${hhi}），结构基本健康。`,
      };
    } else {
      concentration = { level: 'low', message: `渠道结构分散（HHI ${hhi}），抗风险能力较好。` };
    }
  }

  return { channels, hhi, concentration, totalRevenue, activePlatforms };
}
