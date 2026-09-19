/**
 * L6 · views/finance —— 税务全链路测算（PRD F2 / F3）
 *
 * 链路：含税 GMV → 减退款 → 价税分离 → 减成本费用 → 减附加税费/印花税
 *       → 利润总额 → 减企业所得税 → 净利润 → 减分红个税 → 股东到手
 *
 * 瀑布图直接用内核给好的 `cumulative` 渲染，**前端不自己累加**
 * （V9 的瀑布图对不上，正是因为把「利润总额」当成正的增量行重复累加）。
 *
 * 纳税人身份与分红比例是**情景开关**：本页是测算工具，不是申报表 ——
 * 界面必须把这一点说清楚，避免被当成已申报数额。
 */

import {
  computeTaxScenario,
  deriveCosts,
  dividendScenarios,
  toCostBreakdown,
  type TaxpayerType,
  type TaxScenarioResult,
} from '@origo/core';
import type { ViewContext } from '../state.ts';
import { h, card, sectionHead, table, notes, tag, kv, money, formatPct } from '../ui/dom.ts';
import { donut, waterfallChart } from '../ui/charts.ts';
import { periodResult } from './shared.ts';

/** 情景开关（页面级状态，不进内核 —— 内核只按传入参数算） */
const scenario: { taxpayer: TaxpayerType; payoutRatio: number } = {
  taxpayer: 'small',
  payoutRatio: 1,
};

export function renderFinance(ctx: ViewContext): Node {
  const { state } = ctx;
  const s = state.snapshot;
  const r = periodResult(state);
  const m = r.metrics;

  const costs = deriveCosts({
    daily: s.daily,
    window: r.window,
    skuMaster: s.skuMaster,
    costPolicy: s.costPolicy,
    ...(s.skuDaily.length ? { skuDaily: s.skuDaily } : {}),
  });

  const result = computeTaxScenario({
    revenue: m.gmv,
    refund: m.refund,
    costs: toCostBreakdown(costs),
    taxpayer: scenario.taxpayer,
    params: s.taxParams,
    period: { kind: 'month', start: r.window.start, end: r.window.end },
    payoutRatio: scenario.payoutRatio,
  });

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'grid grid--2' },
      card(
        h('p', { class: 'card__title' }, '纳税人身份（情景开关）'),
        h(
          'div',
          { class: 'chips' },
          (['small', 'general'] as TaxpayerType[]).map((t) =>
            h(
              'button',
              {
                class: 'chip',
                'aria-pressed': String(scenario.taxpayer === t),
                onclick: () => {
                  scenario.taxpayer = t;
                  ctx.rerender();
                },
              },
              t === 'small' ? '小规模纳税人' : '一般纳税人',
            ),
          ),
        ),
        h(
          'p',
          { class: 'card__note' },
          scenario.taxpayer === 'small'
            ? '小规模：按 1% 减征率，月销售额 ≤ 10 万元免征增值税。'
            : '一般：销项 13%，进项按科目分档抵扣（物料 13% / 物流 9% / 推广 6%）。',
        ),
      ),
      card(
        h('p', { class: 'card__title' }, '分红比例（情景开关）'),
        h(
          'div',
          { class: 'chips' },
          [0, 0.5, 1].map((p) =>
            h(
              'button',
              {
                class: 'chip',
                'aria-pressed': String(scenario.payoutRatio === p),
                onclick: () => {
                  scenario.payoutRatio = p;
                  ctx.rerender();
                },
              },
              p === 0 ? '不分红' : p === 0.5 ? '半分红' : '全分红',
            ),
          ),
        ),
        h('p', { class: 'card__note' }, `分红个税率 ${formatPct(s.taxParams.dividendTaxRate * 100, 0)}，只在实际分红时发生。`),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('税后到手瀑布图', '从不含税收入逐笔减到净利润，可直接累加校验'),
      card(
        waterfallChart(result.waterfall),
        h(
          'div',
          { class: 'chips-inline', style: { marginTop: '10px' } },
          h('span', { class: 'evidence' }, `起点 不含税收入 ${money(result.netRevenue)}`),
          h('span', { class: 'evidence' }, `终点 净利润 ${money(result.netProfit)}`),
          h('span', { class: 'evidence' }, `含税净销售 ${money(result.grossRevenue)}`),
        ),
        h('p', { class: 'card__note' }, '含税 GMV 刻意不放进瀑布图：它与「不含税收入」是同一笔钱的两种口径，一起累加就会重复计数。'),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('税种明细'),
      h(
        'div',
        { class: 'grid grid--2' },
        card(
          h('p', { class: 'card__title' }, '增值税'),
          kv([
            ['不含税收入', money(result.vat.netRevenue)],
            ['销项税额', money(result.vat.output)],
            ['可抵扣进项', money(result.vat.input)],
            ['应纳税额', money(result.vat.payable)],
            ['留抵结转下期', result.vat.carryoverOut > 0 ? money(result.vat.carryoverOut) : '—'],
            ['有效税率', formatPct(result.vat.effectiveRate * 100)],
          ]),
          result.vat.exempt ? h('div', { style: { marginTop: '8px' } }, tag(result.vat.exemptReason ?? '本期免征', 'ok')) : null,
          table(
            null,
            ['计算步骤', '金额'],
            result.vat.detail.map((d) => [d.step, d.value]),
          ),
        ),
        card(
          h('p', { class: 'card__title' }, '附加税费 / 印花税 / 所得税 / 分红'),
          kv([
            ['附加税费（以实缴增值税为基数）', money(result.surtax.amount)],
            ['印花税（购销合同）', money(result.stamp.amount)],
            ['利润总额', money(result.preTaxProfit)],
            ['企业所得税', money(result.cit.amount)],
            ['净利润', money(result.netProfit)],
            ['分红金额', money(result.dividend.dividend)],
            ['分红个税', money(result.dividend.tax)],
            ['股东到手', money(result.dividend.netToShareholder)],
          ]),
        ),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('成本结构与税负'),
      h(
        'div',
        { class: 'grid grid--2' },
        card(
          h('p', { class: 'card__title' }, '成本费用构成（不含税）'),
          donut(
            result.costBreakdown.map((c) => ({ label: c.label, value: Math.abs(c.amount) })),
            { centerLabel: money(result.netCosts, 0).replace('¥', ''), unit: '成本合计（元）' },
          ),
          table(
            null,
            ['科目', '不含税金额', '占不含税收入'],
            result.costBreakdown.map((c) => [
              c.label,
              money(Math.abs(c.amount)),
              result.netRevenue > 0 ? formatPct((Math.abs(c.amount) / result.netRevenue) * 100) : '—',
            ]),
          ),
        ),
        card(
          h('p', { class: 'card__title' }, '综合税负'),
          h('div', { class: 'hero__value' }, h('span', { class: 'hero__num' }, formatPct(result.taxBurdenRate))),
          h('p', { class: 'hero__sub' }, `税负合计 ${money(result.totalTaxBurden)} ÷ 含税净销售 ${money(result.grossRevenue)}`),
          kv([
            ['增值税', money(result.vat.payable)],
            ['附加税费 + 印花税', money(result.surchargeAndStamp)],
            ['企业所得税', money(result.cit.amount)],
            ['分红个税', money(result.dividend.tax)],
            ['合计', money(result.totalTaxBurden)],
          ]),
          h(
            'div',
            { style: { marginTop: '10px' } },
            tag(costs.quality === 'exact' ? '成本来自真实 BOM' : '成本含估算项', costs.quality === 'exact' ? 'ok' : 'est'),
          ),
        ),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('分红情景对比', '同一份净利润，三种分配方式'),
      card(
        table(
          null,
          ['分红比例', '分红金额', '分红个税', '股东到手', '留存公司'],
          dividendScenarios(result.netProfit, s.taxParams).map((d, i) => [
            ['不分红', '半分红', '全分红'][i] ?? '—',
            money(d.dividend),
            money(d.tax),
            money(d.netToShareholder),
            money(result.netProfit - d.dividend),
          ]),
        ),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('计算前提与未计入项', 'C7：这些必须在界面上说清楚'),
      card(
        h('div', { class: 'chips-inline' }, ...costs.assumptions.map((a) => tag(a, 'est'))),
        notes(result.notes),
        notes([
          `税率来自 data/master/tax-rates.json，政策有效期至 ${s.taxParams.policyValidUntil}；政策变动只需改该文件，不改代码（ADR-09）。`,
          '本页是测算工具，不是申报表：实际申报以账簿与税务机关口径为准。',
        ]),
      ),
    ),
  );
}

export type { TaxScenarioResult };
