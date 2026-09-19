/**
 * L6 · views/channels —— 渠道（平台）结构
 *
 * 回答三个问题：
 *   1. 钱从哪个平台来、结构是不是在变？（营收 + 占比）
 *   2. 哪个渠道在赚钱、哪个在烧钱？（真实净利 + 真实 ROI）
 *   3. 是不是过度依赖单一渠道？（HHI 集中度）
 *
 * 净收入全部由 core.channelBreakdown 重算，不读源表净收入列（7 月事故防线）。
 */

import { PLATFORM_LABEL } from '@origo/core';
import type { ViewContext } from '../state.ts';
import { h, card, sectionHead, table, notes, tag, money, num, formatPct } from '../ui/dom.ts';
import { barList, donut, paletteAt } from '../ui/charts.ts';
import { formatRatio } from '../ui/format.ts';
import { channelReport, periodResult, platformCaveat } from './shared.ts';

const CONCENTRATION_LABEL: Record<'low' | 'medium' | 'high', string> = {
  low: '分散',
  medium: '中等集中',
  high: '高度集中',
};

/** 与 tag() 支持的样式类对齐 */
const CONCENTRATION_KIND: Record<'low' | 'medium' | 'high', 'ok' | 'est' | 'alloc'> = {
  low: 'ok',
  medium: 'alloc',
  high: 'est',
};

export function renderChannels(ctx: ViewContext): Node {
  const { state } = ctx;
  const r = periodResult(state);
  const ch = channelReport(state, r.window);
  const level = ch.concentration?.level;

  const rows: (string | Node)[][] = ch.channels.map((c) => [
    c.active
      ? h('span', { class: 'strong' }, PLATFORM_LABEL[c.platform])
      : h('span', { class: 'dim' }, PLATFORM_LABEL[c.platform]),
    money(c.revenue, 0),
    `${formatPct(c.shareOfRevenue, 1)}`,
    `${num(c.qty)}`,
    money(c.aov, 0),
    c.refund > 0 ? h('span', { class: 'down' }, money(-c.refund, 0)) : h('span', { class: 'dim' }, '—'),
    `${formatPct(c.refundRate, 1)}`,
    money(c.promotion, 0),
    `${formatPct(c.promoRate, 1)}`,
    money(c.net, 0),
    money(c.realProfit, 0),
    c.realRoi === null
      ? h('span', { class: 'dim' }, '—')
      : h('span', { class: roiClass(c.realRoi) }, formatRatio(c.realRoi)),
    c.active ? tag('有数据', 'ok') : tag('本期无数据', 'off'),
  ]);

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'grid grid--3' },
      card(
        h('p', { class: 'card__title' }, '渠道集中度（HHI）'),
        h('div', { class: 'hero__value' }, h('span', { class: 'hero__num' }, ch.hhi.toFixed(3))),
        h(
          'p',
          { class: 'hero__sub' },
          level
            ? h('span', {}, tag(CONCENTRATION_LABEL[level], CONCENTRATION_KIND[level]), ` 活跃平台 ${ch.activePlatforms} 个`)
            : '数据不足以判断集中度',
        ),
        h('p', { class: 'card__note' }, ch.concentration?.message ?? '本期没有营收数据，无法计算集中度。'),
      ),
      card(
        h('p', { class: 'card__title' }, '第一大渠道'),
        (() => {
          const top = ch.channels.find((c) => c.active);
          if (!top) return h('p', { class: 'card__note' }, '本期没有任何平台产生营收。');
          return h(
            'div',
            {},
            h('div', { class: 'hero__value' }, h('span', { class: 'hero__num' }, PLATFORM_LABEL[top.platform]),
              h('span', { class: 'hero__unit' }, `占 ${formatPct(top.shareOfRevenue, 1)}`)),
            h(
              'dl',
              { class: 'kv' },
              h('dt', {}, '营收'), h('dd', {}, money(top.revenue, 0)),
              h('dt', {}, '退款率'), h('dd', {}, formatPct(top.refundRate)),
              h('dt', {}, '推广费率'), h('dd', {}, formatPct(top.promoRate)),
              h('dt', {}, '真实净利'), h('dd', {}, money(top.realProfit, 0)),
              h('dt', {}, '真实 ROI'), h('dd', {}, formatRatio(top.realRoi)),
            ),
          );
        })(),
      ),
      card(
        h('p', { class: 'card__title' }, '渠道健康度分档'),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, '安全（ROI ≥ 1.5）'),
          h('dd', {}, `${ch.channels.filter((c) => c.active && (c.realRoi ?? 0) >= 1.5).length} 个`),
          h('dt', {}, '保本线上（1–1.5）'),
          h('dd', {}, `${ch.channels.filter((c) => c.active && (c.realRoi ?? 0) >= 1 && (c.realRoi ?? 0) < 1.5).length} 个`),
          h('dt', {}, '亏损（< 1）'),
          h('dd', {}, `${ch.channels.filter((c) => c.active && c.realRoi !== null && c.realRoi < 1).length} 个`),
          h('dt', {}, '无投放/无成本分母'),
          h('dd', {}, `${ch.channels.filter((c) => c.active && c.realRoi === null).length} 个`),
        ),
        h('p', { class: 'card__note' }, '「无分母」的渠道返回「—」而不是 ∞ —— 不会把没有投放的渠道误判成亏损。'),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('平台明细', `重算口径：净收入 = 营收 − 退款 − 推广`),
      card(
        table(
          null,
          ['平台', '营收', '占比', '销量', '客单价', '退款', '退款率', '推广', '推广费率', '净收入', '真实净利', '真实 ROI', '状态'],
          rows,
        ),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('结构可视化'),
      h(
        'div',
        { class: 'grid grid--2' },
        card(
          h('p', { class: 'card__title' }, '营收结构'),
          donut(
            ch.channels
              .filter((c) => c.revenue > 0)
              .map((c) => ({ label: PLATFORM_LABEL[c.platform], value: c.revenue })),
            { centerLabel: money(ch.totalRevenue, 0).replace('¥', ''), unit: '总营收（元）' },
          ),
        ),
        card(
          h('p', { class: 'card__title' }, '各平台真实净利'),
          barList(
            ch.channels
              .filter((c) => c.active)
              .map((c, i) => ({
                label: PLATFORM_LABEL[c.platform],
                value: c.realProfit,
                display: money(c.realProfit, 0),
                color: c.realProfit < 0 ? '#b3261e' : paletteAt(i),
                note: c.realRoi === null ? null : h('small', {}, ` ROI ${formatRatio(c.realRoi)}`),
              })),
          ),
        ),
      ),
    ),

    platformCaveat(ch),
    notes([
      '所有平台的净收入、真实净利、ROI 都由内核从日流水重算，不读源表里的「净收入」列。',
      '5 个平台行**恒定出现**（C4）：缺数据的渠道标灰显示「本期无数据」，而不是隐藏成 0 —— 隐藏会让人误以为"这个渠道没有"。',
      '推广费在渠道维度是源表原始值；单品维度的推广费才涉及分摊（见产品页角标）。',
    ]),
  );
}

function roiClass(roi: number): string {
  if (roi >= 1.5) return 'up';
  if (roi >= 1) return '';
  return 'down';
}
