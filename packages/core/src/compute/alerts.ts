/**
 * L5 · compute/alerts —— 经营预警（PRD C2）
 *
 * 原则（ADR-08）：
 *   1. 预警必须**能被追溯**到具体数字与阈值，不说"经营状况不佳"这类空话；
 *   2. 无目标值时**不假装有目标** —— 缺口显式提示"未设置目标"，不臆造达成率；
 *   3. 排序按严重度，同级按影响金额。
 *
 * V9 的 ROI 误报（把毛利率当 ROI、把无推广当天算成 ROI=∞）在此彻底修正：
 * 分母为 0 一律返回 null，不产出预警。
 */

import type { DailyRecord, Platform } from '../model/daily.ts';
import { PLATFORM_LABEL } from '../model/daily.ts';
import type { InventoryCoverage } from '../model/supply.ts';
import type { PeriodMetrics, PeriodResult } from './aggregate.ts';
import type { ChannelReport } from './channel.ts';

export type AlertLevel = 'critical' | 'warning' | 'info';

export interface Alert {
  id: string;
  level: AlertLevel;
  /** 分类：营收 / 成本 / 渠道 / 退款 / 库存 / 数据 */
  category: 'revenue' | 'cost' | 'channel' | 'refund' | 'inventory' | 'data';
  title: string;
  /** 一句话结论，必须含具体数字 */
  message: string;
  /** 建议动作 */
  action: string;
  /** 影响金额（用于排序与优先级）；无金额为 null */
  impact: number | null;
  /** 证据链（可下钻） */
  evidence: { label: string; value: string }[];
}

/** 经营目标（data/master/targets.json）；缺省时相关预警降级为 info */
export interface Targets {
  /** 月度营收目标（元） */
  monthlyRevenue?: number;
  /** 月度真实净利目标（元） */
  monthlyProfit?: number;
  /** 真实 ROI 下限（默认 1.5） */
  minRealRoi?: number;
  /** 退款率上限（%，默认 8） */
  maxRefundRate?: number;
  /** 推广费率上限（%，默认 35） */
  maxPromoRate?: number;
}

export interface AlertInput {
  period: PeriodResult;
  channels: ChannelReport;
  inventory?: readonly InventoryCoverage[];
  targets?: Targets;
  /** 最近 N 天的日级数据（用于连续下滑检测） */
  daily: readonly DailyRecord[];
}

const money = (v: number) =>
  `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export function buildAlerts(input: AlertInput): Alert[] {
  const alerts: Alert[] = [];
  const { period, channels, inventory, targets = {}, daily } = input;
  const m: PeriodMetrics = period.metrics;

  // ---------- 1. 真实 ROI ----------
  const minRoi = targets.minRealRoi ?? 1.5;
  if (m.realRoi !== null && m.realRoi < 1) {
    alerts.push({
      id: 'roi-loss',
      level: 'critical',
      category: 'cost',
      title: '真实 ROI 低于 1（卖一单亏一单）',
      message: `真实 ROI ${m.realRoi}，低于保本线 1。本期营收 ${money(m.gmv)}，物料 ${money(m.materialCost)}，推广 ${money(m.promotion)}。`,
      action: '立即暂停 ROI<1 的投放计划，复核单品毛利后再放量。',
      impact: m.realRoi > 0 ? Math.round(m.gmv * (1 / m.realRoi - 1)) : null,
      evidence: [
        { label: '真实 ROI', value: String(m.realRoi) },
        { label: '物料成本', value: money(m.materialCost) },
        { label: '推广费', value: money(m.promotion) },
      ],
    });
  } else if (m.realRoi !== null && m.realRoi < minRoi) {
    alerts.push({
      id: 'roi-below-target',
      level: 'warning',
      category: 'cost',
      title: `真实 ROI 低于安全线 ${minRoi}`,
      message: `真实 ROI ${m.realRoi}，处于保本线上、安全线以下。距安全线还需把推广费降 ${money(Math.max(0, m.gmv / minRoi - m.materialCost - m.promotion))} 或把营收提 ${money(Math.max(0, (m.materialCost + m.promotion) * minRoi - m.gmv))}。`,
      action: '优化投放结构，优先保留真实 ROI ≥ 1.5 的计划。',
      impact: null,
      evidence: [{ label: '真实 ROI', value: String(m.realRoi) }, { label: '安全线', value: String(minRoi) }],
    });
  }

  // ---------- 2. 目标达成 ----------
  if (targets.monthlyRevenue && period.window.kind === 'month') {
    const base = period.window.isPartialMonth && m.projected ? m.projected.gmv : m.gmv;
    const rate = Math.round((base / targets.monthlyRevenue) * 1000) / 10;
    const level: AlertLevel = rate >= 100 ? 'info' : rate >= 80 ? 'warning' : 'critical';
    alerts.push({
      id: 'target-revenue',
      level,
      category: 'revenue',
      title: rate >= 100 ? '月度营收目标已达成' : '月度营收目标存在缺口',
      message: `按${period.window.isPartialMonth ? '整月预估' : '当前'}口径，达成率 ${rate}%（${money(base)} / ${money(targets.monthlyRevenue)}）。`,
      action: rate >= 100 ? '保持节奏。' : `剩余缺口 ${money(Math.max(0, targets.monthlyRevenue - base))}。`,
      impact: Math.max(0, targets.monthlyRevenue - base),
      evidence: [
        { label: '口径', value: period.window.isPartialMonth ? '整月预估（估算）' : '实际' },
        { label: '达成率', value: `${rate}%` },
      ],
    });
  } else if (!targets.monthlyRevenue && period.window.kind === 'month') {
    alerts.push({
      id: 'target-missing',
      level: 'info',
      category: 'data',
      title: '尚未设置营收目标',
      message: '缺少 data/master/targets.json，无法计算达成率。',
      action: '填写月营收 / 净利目标后，本看板将自动给出达成率与缺口。',
      impact: null,
      evidence: [],
    });
  }

  // ---------- 3. 退款率 ----------
  const maxRefund = targets.maxRefundRate ?? 8;
  if (m.refundRate > maxRefund) {
    alerts.push({
      id: 'refund-rate',
      level: m.refundRate > maxRefund * 1.5 ? 'critical' : 'warning',
      category: 'refund',
      title: `退款率 ${m.refundRate}% 高于阈值 ${maxRefund}%`,
      message: `本期退款 ${money(m.refund)}，退款率 ${m.refundRate}%（阈值 ${maxRefund}%）。`,
      action: '核查物流破损与描述不符投诉，抽查高退款 SKU。',
      impact: m.refund,
      evidence: [{ label: '退款额', value: money(m.refund) }, { label: '退款率', value: `${m.refundRate}%` }],
    });
  }

  // ---------- 4. 推广费率 ----------
  const maxPromo = targets.maxPromoRate ?? 35;
  if (m.promoRate > maxPromo) {
    alerts.push({
      id: 'promo-rate',
      level: 'warning',
      category: 'cost',
      title: `推广费率 ${m.promoRate}% 偏高`,
      message: `推广费 ${money(m.promotion)}，占营收 ${m.promoRate}%（阈值 ${maxPromo}%）。`,
      action: '检查是否存在低效计划；结合单品真实 ROI 决定关停。',
      impact: m.promotion,
      evidence: [{ label: '推广费', value: money(m.promotion) }, { label: '推广费率', value: `${m.promoRate}%` }],
    });
  }

  // ---------- 5. 渠道集中度 ----------
  if (channels.concentration?.level === 'high') {
    alerts.push({
      id: 'channel-concentration',
      level: 'warning',
      category: 'channel',
      title: '渠道过度集中',
      message: channels.concentration.message,
      action: '把第二渠道的月营收占比目标设为 ≥ 30%，按周追踪。',
      impact: channels.channels[0]?.revenue ?? null,
      evidence: channels.channels.slice(0, 3).map((c) => ({ label: c.label, value: `${c.shareOfRevenue}%` })),
    });
  }

  // ---------- 6. 渠道 ROI 亏损 ----------
  for (const c of channels.channels) {
    if (c.active && c.realRoi !== null && c.realRoi < 1) {
      alerts.push({
        id: `channel-loss-${c.platform}`,
        level: 'critical',
        category: 'channel',
        title: `${c.label} 渠道单均亏损`,
        message: `${c.label} 真实 ROI ${c.realRoi}（营收 ${money(c.revenue)} / 物料+推广 ${money(c.materialCost + c.promotion)}）。`,
        action: `暂停 ${c.label} 的低效计划，或提高客单价至 ${money((c.materialCost + c.promotion) / Math.max(1, c.qty))} 以上。`,
        impact: Math.round(c.materialCost + c.promotion - c.revenue),
        evidence: [
          { label: '营收', value: money(c.revenue) },
          { label: '真实 ROI', value: String(c.realRoi) },
        ],
      });
    }
  }

  // ---------- 7. 连续下滑 ----------
  const trend = revenueTrend(daily, period.window.end, 3);
  if (trend && trend.every((d) => d < 0) && trend.length >= 2) {
    alerts.push({
      id: 'revenue-decline',
      level: 'warning',
      category: 'revenue',
      title: '营收连续 3 天下滑',
      message: `最近 3 天营收环比分别为 ${trend.map((d) => `${Math.round(d * 100) / 100}%`).join(' / ')}。`,
      action: '核查流量入口与投放是否被限流，检查竞品价格动作。',
      impact: null,
      evidence: [],
    });
  }

  // ---------- 8. 库存 ----------
  if (inventory) {
    for (const c of inventory) {
      if (c.status === 'stockout' || c.status === 'urgent') {
        alerts.push({
          id: `inventory-${c.sku}`,
          level: c.status === 'stockout' ? 'critical' : 'warning',
          category: 'inventory',
          title: `${c.sku} ${c.status === 'stockout' ? '已断货' : '库存告急'}`,
          message: c.message,
          action: c.suggestedQty > 0 ? `建议补货 ${c.suggestedQty} 瓶。` : '请核对库存主数据。',
          impact: null,
          evidence: [
            { label: '现有库存', value: `${c.onHand}` },
            { label: '可售天数', value: c.coverDays === null ? '—' : `${c.coverDays}` },
          ],
        });
      }
    }
  }

  const rank: Record<AlertLevel, number> = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.level] - rank[b.level] || (b.impact ?? 0) - (a.impact ?? 0));
}

/** 最近 n 天的日营收环比（%），末位为最新；数据不足返回 null */
function revenueTrend(daily: readonly DailyRecord[], endDate: string, days: number): number[] | null {
  const byDate = new Map<string, number>();
  for (const r of daily) {
    if (r.date > endDate) continue;
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.revenue);
  }
  const dates = [...byDate.keys()].sort().slice(-(days + 1));
  if (dates.length < 2) return null;
  const out: number[] = [];
  for (let i = 1; i < dates.length; i += 1) {
    const prev = byDate.get(dates[i - 1]!) ?? 0;
    const cur = byDate.get(dates[i]!) ?? 0;
    if (prev <= 0) return null;
    out.push(((cur - prev) / prev) * 100);
  }
  return out;
}

/** 平台标签便捷导出（前端展示用，避免前端自己维护一份中文名） */
export function platformLabel(p: Platform): string {
  return PLATFORM_LABEL[p];
}
