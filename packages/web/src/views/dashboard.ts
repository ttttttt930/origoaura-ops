/**
 * L6 · views/dashboard —— 经营驾驶舱
 *
 * 结构（自上而下 = 从结论到证据）：
 *   Hero 四卡 → 时间口径 → 智能预警 → 营收趋势 → 渠道结构 / 成本结构
 * 所有指标来自 core：heroCards / aggregatePeriod / channelBreakdown / buildAlerts。
 */

import { heroCards, PLATFORM_LABEL, roiZone, type HeroCard } from '@origo/core';
import type { ViewContext } from '../state.ts';
import { h, card, sectionHead, tag, deltaChip, money, num, formatPct } from '../ui/dom.ts';
import { areaChart, donut, barList } from '../ui/charts.ts';
import { formatRatio, roiZoneLabel } from '../ui/format.ts';
import { alerts, caveats, channelReport, periodResult, periodStrip } from './shared.ts';

/**
 * Hero 卡（沿用 V9 的四卡条）：第一张为深蓝渐变主卡，其余浅底。
 * 主卡放最关键的指标（营收），与老看板的信息层级一致。
 */
function heroCard(c: HeroCard, index: number): HTMLElement {
  const value =
    c.unit === 'currency'
      ? h('span', { class: 'hero__num' }, c.value === null ? '—' : money(c.value, 0))
      : h('span', { class: 'hero__num' }, c.value === null ? '—' : formatRatio(c.value));

  const zone = index === 0 ? 'primary' : c.zone;

  return h(
    'section',
    { class: `card hero${zone ? ` hero--${zone}` : ''}` },
    h(
      'div',
      { class: 'hero__head' },
      h('span', { class: 'hero__label' }, c.title),
      deltaChip(c.delta),
    ),
    h('div', { class: 'hero__value' }, value, c.unit === 'currency' ? h('span', { class: 'hero__unit' }, '元') : null),
    h('p', { class: 'hero__sub' }, c.compareLabel ? `${c.compareLabel}　` : '', c.sub),
  );
}

export function renderDashboard(ctx: ViewContext): Node {
  const { state } = ctx;
  const r = periodResult(state);
  const m = r.metrics;
  const ch = channelReport(state, r.window);
  const cards = heroCards(r);

  // 日序列（窗口内）
  const byDate = new Map<string, number>();
  for (const rec of state.snapshot.daily) {
    if (rec.date < r.window.start || rec.date > r.window.end) continue;
    byDate.set(rec.date, (byDate.get(rec.date) ?? 0) + rec.revenue);
  }
  const series = [...byDate.entries()].sort().map(([date, value]) => ({ label: date, value }));

  const costItems = [
    { label: '营收 GMV', value: m.gmv, display: money(m.gmv, 0) },
    { label: '物料成本', value: m.materialCost, display: money(m.materialCost, 0) },
    { label: '推广费', value: m.promotion, display: money(m.promotion, 0) },
    { label: '退款', value: m.refund, display: money(m.refund, 0) },
    { label: '真实净利', value: m.realProfit, display: money(m.realProfit, 0) },
    { label: '现金回款', value: m.cashback, display: money(m.cashback, 0) },
  ];

  const alertList = alerts(state);

  return h(
    'div',
    {},
    h('div', { class: 'grid grid--hero' }, ...cards.map((c, i) => heroCard(c, i))),

    // 六列 KPI 条（老看板的 .dkpis）：把收支六项平铺，一眼扫完，不必展开图表
    h(
      'div',
      { class: 'grid grid--kpi', style: { marginTop: '14px' } },
      ...costItems.map((it) =>
        h(
          'div',
          { class: 'kpi' },
          h('div', { class: 'kpi__label' }, it.label),
          h('div', { class: 'kpi__value' }, it.display),
        ),
      ),
    ),

    h('section', { class: 'section' }, sectionHead('时间口径'), h('div', { class: 'grid grid--2' },
      card(
        h('p', { class: 'card__title' }, `当前窗口 · ${r.window.kind}`),
        periodStrip(r),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, '有数据天数'), h('dd', {}, `${num(r.window.observedDays)} / ${r.window.calendarDays} 天`),
          h('dt', {}, '日均营收'), h('dd', {}, money(m.dailyAvgGmv)),
          h('dt', {}, '客单价'), h('dd', {}, money(m.aov, 0)),
          h('dt', {}, '销量'), h('dd', {}, `${num(m.qty)} 瓶`),
        ),
        r.window.isPartialMonth && m.projected
          ? h(
              'div',
              { style: { marginTop: '12px' } },
              tag('整月预估 · 估算', 'est'),
              h(
                'dl',
                { class: 'kv', style: { marginTop: '8px' } },
                h('dt', {}, '预估营收'), h('dd', {}, money(m.projected.gmv, 0)),
                h('dt', {}, '预估真实净利'), h('dd', {}, money(m.projected.realProfit, 0)),
                h('dt', {}, '预估回款'), h('dd', {}, money(m.projected.cashback, 0)),
                h('dt', {}, '放大系数'), h('dd', {}, `×${(r.window.projFactor ?? 1).toFixed(2)}`),
              ),
              h('p', { class: 'card__note' }, `按已过 ${r.window.monthDaysSoFar} 天的日均外推到 ${r.window.monthDaysTotal} 天；同比一律用「上月同长度日」切片，禁止整月比部分月。`),
            )
          : null,
      ),
      card(
        h('p', { class: 'card__title' }, '效率与风险'),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, '真实 ROI'), h('dd', {}, formatRatio(m.realRoi)),
          h('dt', {}, 'ROI 分档'), h('dd', {}, roiZoneLabel(roiZone(m.realRoi))),
          h('dt', {}, '毛 ROI（营收÷推广）'), h('dd', {}, m.roi === null ? '—（无推广）' : formatRatio(m.roi)),
          h('dt', {}, '退款率'), h('dd', {}, formatPct(m.refundRate)),
          h('dt', {}, '推广费率'), h('dd', {}, formatPct(m.promoRate)),
          h('dt', {}, '物料成本口径'),
          h('dd', {}, m.unitCostEstimated ? h('span', {}, tag('估算', 'est')) : '实采'),
        ),
        h('p', { class: 'card__note' }, '真实 ROI = 营收 ÷（物料 + 推广）。分母为 0 时返回「—」而不是 ∞，避免把无投放的日子误报成亏损（V9 的误报已修）。'),
      ),
    )),

    h(
      'section',
      { class: 'section' },
      sectionHead('智能预警', `共 ${alertList.length} 条，按严重度排序`),
      alertList.length
        ? h(
            'div',
            { class: 'alerts' },
            ...alertList.map((a) =>
              h(
                'div',
                { class: `alert alert--${a.level}` },
                h('div', { class: 'alert__ico' }, a.level === 'critical' ? '🔴' : a.level === 'warning' ? '🟠' : '🔵'),
                h(
                  'div',
                  {},
                  h('h4', { class: 'alert__title' }, a.title),
                  h('p', { class: 'alert__msg' }, a.message),
                  a.action ? h('p', { class: 'alert__action' }, '建议动作：', h('b', {}, a.action)) : null,
                  a.evidence.length
                    ? h('div', { class: 'alert__meta' }, ...a.evidence.map((e) => h('span', { class: 'evidence' }, `${e.label} ${e.value}`)))
                    : null,
                ),
              ),
            ),
          )
        : card(h('p', { class: 'card__note' }, '本期没有触发任何预警阈值。')),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('营收趋势', `窗口内 ${series.length} 天，悬停查看当日数值`),
      card(series.length ? areaChart(series, { markGaps: true, height: 200 }) : h('p', { class: 'card__note' }, '本窗口内没有数据。')),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('渠道结构与成本结构'),
      h(
        'div',
        { class: 'grid grid--2' },
        card(
          h('p', { class: 'card__title' }, '营收结构（按平台）'),
          donut(
            ch.channels
              .filter((c) => c.revenue > 0)
              .map((c) => ({ label: PLATFORM_LABEL[c.platform], value: c.revenue })),
            { centerLabel: ch.activePlatforms.toString(), unit: '个活跃平台' },
          ),
        ),
        card(h('p', { class: 'card__title' }, '收支构成（元）'), barList(costItems)),
      ),
    ),

    caveats(state),
  );
}
