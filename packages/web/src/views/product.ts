/**
 * L6 · views/product —— 产品 / SKU 真实毛利
 *
 * ADR-08：源数据缺失时，内核返回**结构化 DataGap**，本页据此渲染空态 + 三步入手指引，
 * 绝不补 0、绝不用等权估算假装算出了毛利（V9 的"综合单瓶成本 × 总销量"就是这么骗人的）。
 *
 * 有数据时的口径：
 *   成本 = SkuMaster.unitCost（真实 BOM 核定值，元/瓶）× 销量
 *   净利 = 收入 − 退款 − 物料 − 平台佣金 − 支付手续费 − 物流 − 推广
 *   所有假设（分摊、一单一瓶）都由内核写在 assumptions 里，界面必须逐条展示（C7）。
 */

import {
  bomQuality,
  computeSkuMargins,
  isDataGap,
  PLATFORM_LABEL,
  rollupBySku,
  skuPlatformBreakdown,
  type DataGap,
  type SkuMargin,
} from '@origo/core';
import type { ViewContext } from '../state.ts';
import { h, card, sectionHead, table, notes, tag, emptyState, money, num, formatPct } from '../ui/dom.ts';
import { barList, donut } from '../ui/charts.ts';
import { formatRatio } from '../ui/format.ts';
import { periodResult } from './shared.ts';

export function renderProduct(ctx: ViewContext): Node {
  const { state } = ctx;
  const r = periodResult(state);
  const s = state.snapshot;

  const result = computeSkuMargins(s.skuDaily, s.skuMaster, s.costPolicy, {
    from: r.window.start,
    to: r.window.end,
  });

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'grid grid--3' },
      card(
        h('p', { class: 'card__title' }, '在售 SKU'),
        h('div', { class: 'hero__value' }, h('span', { class: 'hero__num' }, num(s.skuMaster.length))),
        h('p', { class: 'hero__sub' }, `${s.skuMaster.filter((x) => x.status === 'active').length} 款在售 · 成本口径 ${s.skuMaster[0]?.costBasis ?? '—'}`),
      ),
      card(
        h('p', { class: 'card__title' }, 'SKU×日 数据'),
        h('div', { class: 'hero__value' }, h('span', { class: 'hero__num' }, num(s.skuDaily.length))),
        h(
          'p',
          { class: 'hero__sub' },
          s.skuDaily.length
            ? '已有商品维度明细，可计算单品真实毛利。'
            : '尚无商品维度明细 —— 单品毛利只能显示空态。',
        ),
      ),
      card(
        h('p', { class: 'card__title' }, 'BOM 明细可信度'),
        (() => {
          const q = bomQuality(s.skuMaster);
          return h(
            'div',
            {},
            h('div', { class: 'hero__value' }, h('span', { class: 'hero__num' }, `${q.verified}/${q.verified + q.placeholder}`)),
            h('p', { class: 'hero__sub' }, q.note),
            h(
              'div',
              { class: 'chips-inline', style: { marginTop: '8px' } },
              q.allVerified ? tag('全部可追溯', 'ok') : tag('含占位结构 · 结构示意', 'est'),
            ),
          );
        })(),
      ),
    ),

    isDataGap(result)
      ? renderGap(result)
      : renderMargins(ctx, result as SkuMargin[]),
  );
}

function renderGap(gap: DataGap): HTMLElement {
  return h(
    'section',
    { class: 'section' },
    sectionHead('单品真实毛利'),
    emptyState(
      {
        'sku-daily': '缺「商品 × 平台 × 日」明细',
        'sku-master': '缺 SKU 主数据',
        'cost-policy': '缺全成本口径',
      }[gap.scope] ?? '数据缺口',
      gap.message,
      gap.steps,
      '🧩',
    ),
    h(
      'p',
      { class: 'card__note', style: { marginTop: '12px' } },
      '这里刻意不用「综合单瓶成本 × 总销量」去凑一个看起来像毛利的数字：等权估算会把 5 款成本 13.72–23.08 元的香水平均成同一个数，据此做的定价与取舍一定是错的。',
    ),
  );
}

function renderMargins(ctx: ViewContext, margins: readonly SkuMargin[]): HTMLElement {
  const { state } = ctx;
  const rollup = rollupBySku(margins);
  const s = state.snapshot;

  const rollupRows = rollup.map((row) => {
    const master = s.skuMaster.find((m) => m.sku === row.sku);
    return [
      h('span', { class: 'strong' }, row.sku),
      master?.productLine ?? '—',
      num(row.qty),
      money(row.revenue, 0),
      money(row.cogs, 0),
      money(row.promotion, 0),
      money(row.net, 0),
      h('span', { class: row.net >= 0 ? 'up' : 'down' }, formatPct(row.netMarginRate * 100, 1)),
      formatRatio(row.roi),
      h(
        'span',
        { class: 'chips-inline' },
        row.allocated ? tag('推广分摊', 'alloc') : tag('推广直连', 'ok'),
        h('span', { class: 'dim' }, `${row.platformCount} 个平台`),
      ),
    ];
  });

  const detailRows = margins.map((m) => [
    m.sku,
    PLATFORM_LABEL[m.platform],
    num(m.qty),
    money(m.revenue, 0),
    money(m.cogs, 0),
    money(m.commission, 0),
    money(m.paymentFee, 0),
    money(m.logistics, 0),
    money(m.promotion, 0),
    money(m.net, 0),
    h('span', { class: m.net >= 0 ? 'up' : 'down' }, formatPct(m.netMarginRate * 100, 1)),
    formatRatio(m.roi),
  ]);

  const allAssumptions = [...new Set(margins.flatMap((m) => m.assumptions))];

  return h(
    'div',
    {},
    h(
      'section',
      { class: 'section' },
      sectionHead('单品毛利榜单', '按营收降序'),
      card(
        table(
          null,
          ['SKU', '产品线', '销量', '收入', '物料', '推广', '净利', '净利率', 'ROI', '口径'],
          rollupRows,
        ),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('净利结构'),
      h(
        'div',
        { class: 'grid grid--2' },
        card(
          h('p', { class: 'card__title' }, '各 SKU 净利'),
          barList(
            rollup.map((row) => ({
              label: row.sku.replace('50ml', ''),
              value: row.net,
              display: money(row.net, 0),
              color: row.net < 0 ? '#b3261e' : undefined,
            })),
          ),
        ),
        card(
          h('p', { class: 'card__title' }, '营收构成'),
          donut(rollup.filter((x) => x.revenue > 0).map((x) => ({ label: x.sku, value: x.revenue }))),
        ),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('SKU × 平台 明细', '物料成本 = 真实 BOM 单位成本 × 销量'),
      card(
        table(
          null,
          ['SKU', '平台', '销量', '收入', '物料', '佣金', '手续费', '物流', '推广', '净利', '净利率', 'ROI'],
          detailRows,
        ),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('渠道下钻'),
      card(
        h(
          'div',
          { class: 'grid grid--2' },
          ...rollup.slice(0, 4).map((row) =>
            h(
              'div',
              {},
              h('p', { class: 'card__title' }, row.sku),
              barList(
                skuPlatformBreakdown(margins, row.sku).map((b) => ({
                  label: PLATFORM_LABEL[b.platform],
                  value: b.revenue,
                  display: money(b.revenue, 0),
                })),
              ),
            ),
          ),
        ),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('本页计算所依赖的假设', 'C7：近似必须标出来，不能藏在数字背后'),
      card(
        allAssumptions.length
          ? h('div', { class: 'chips-inline' }, ...allAssumptions.map((a) => tag(a, 'alloc')))
          : h('p', { class: 'card__note' }, '无近似假设：成本与推广均为直连实采值。'),
        notes([
          '物料成本取 SkuMaster.unitCost（OA 供应商报价核定值，含包装），**永远不做等权估算**。',
          '等权 / 加权估算只允许出现在驾驶舱的「综合单瓶成本」角标里，且必须打「估算」。',
          '灌装 / 人工 / 包材损耗尚未取数，按 0 参与计算 —— 实际净利会低于本页数值。',
        ]),
      ),
    ),
  );
}
