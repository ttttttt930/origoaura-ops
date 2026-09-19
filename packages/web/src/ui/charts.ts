/**
 * L6 · ui/charts —— 手写 SVG 图表（零依赖）
 *
 * 为什么不用图表库：V10 是静态站点（C6），图库体积（>100KB）与"必须在 GitHub Pages
 * 子路径下正常加载"的约束不对称；而这里需要的只是面积图 / 环形图 / 瀑布图三种。
 * 全部图表都是纯函数：(数据) → SVGElement，不持有状态，便于整页重渲染。
 */

import { h, s, type Child } from './dom.ts';
import { moneyShort } from './format.ts';

const PALETTE = ['#a9764b', '#4a6580', '#3f7d54', '#c98a1f', '#8a6d9c', '#b3261e'];

export function paletteAt(i: number): string {
  return PALETTE[i % PALETTE.length]!;
}

export interface SeriesPoint {
  label: string;
  value: number;
  /** 悬停补充说明 */
  hint?: string;
}

export interface AreaChartOptions {
  width?: number;
  height?: number;
  /** y 轴最小值（默认 0） */
  min?: number;
  color?: string;
  /** 是否在异常点打标记（value === 0 且前后有数据时提示"无数据"） */
  markGaps?: boolean;
  yFormat?: (v: number) => string;
}

/**
 * 折线 + 面积图（日序列）。刻意自绘坐标轴与网格，避免图库的默认英文文案。
 */
export function areaChart(points: readonly SeriesPoint[], opts: AreaChartOptions = {}): SVGElement {
  const W = opts.width ?? 680;
  const H = opts.height ?? 190;
  const pad = { top: 14, right: 12, bottom: 26, left: 52 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;
  const color = opts.color ?? '#a9764b';
  const fmt = opts.yFormat ?? moneyShort;

  const values = points.map((p) => p.value);
  const rawMax = values.length ? Math.max(...values) : 0;
  const max = rawMax > 0 ? rawMax * 1.12 : 1;
  const min = opts.min ?? 0;

  const x = (i: number) => pad.left + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => pad.top + ih - ((v - min) / (max - min)) * ih;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area =
    points.length > 0
      ? `${line} L${x(points.length - 1).toFixed(1)},${(pad.top + ih).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + ih).toFixed(1)} Z`
      : '';

  // y 轴 4 条网格线
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + (max - min) * t);
  const gridNodes = ticks.map((tv) =>
    s(
      'g',
      {},
      s('line', {
        x1: pad.left,
        x2: pad.left + iw,
        y1: y(tv).toFixed(1),
        y2: y(tv).toFixed(1),
        stroke: '#e3d9c8',
        'stroke-width': 1,
        'stroke-dasharray': tv === min ? '0' : '3 4',
      }),
      s('text', { x: pad.left - 7, y: (y(tv) + 3.5).toFixed(1), 'text-anchor': 'end' }, fmt(tv)),
    ),
  );

  // x 轴标签：最多 7 个，避免重叠
  const step = Math.max(1, Math.ceil(points.length / 7));
  const xLabels = points.map((p, i) =>
    i % step === 0 || i === points.length - 1
      ? s(
          'text',
          { x: x(i).toFixed(1), y: H - 8, 'text-anchor': 'middle' },
          p.label.slice(5),
        )
      : null,
  );

  const dots = points.map((p, i) =>
    s('circle', {
      cx: x(i).toFixed(1),
      cy: y(p.value).toFixed(1),
      r: 3,
      fill: '#fffdf9',
      stroke: color,
      'stroke-width': 1.6,
    }, s('title', {}, `${p.label}　${fmt(p.value)}${p.hint ? `　${p.hint}` : ''}`)),
  );

  // 断档提示：value 为 0 的日期打一个浅色标记（"这天没有数据"）
  const gaps = opts.markGaps
    ? points.map((p, i) =>
        p.value === 0
          ? s('rect', {
              x: (x(i) - 2.5).toFixed(1),
              y: pad.top,
              width: 5,
              height: ih,
              fill: '#d3c5ad',
              opacity: 0.22,
            }, s('title', {}, `${p.label}　当日无数据`))
          : null,
      )
    : [];

  return s(
    'svg',
    {
      class: 'chart',
      viewBox: `0 0 ${W} ${H}`,
      role: 'img',
      'aria-label': '营收趋势图',
      preserveAspectRatio: 'xMidYMid meet',
    },
    ...gridNodes,
    area ? s('path', { d: area, fill: color, opacity: 0.14 }) : null,
    line ? s('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }) : null,
    ...gaps,
    ...xLabels,
    ...dots,
  );
}

export interface DonutSlice {
  label: string;
  value: number;
  color?: string;
}

/** 环形图 + 图例（渠道结构 / 成本结构） */
export function donut(slices: readonly DonutSlice[], opts: { size?: number; centerLabel?: string; unit?: string } = {}): HTMLElement {
  const size = opts.size ?? 168;
  const r = size / 2;
  const thickness = 22;
  const radius = r - thickness / 2 - 2;
  const total = slices.reduce((a, sl) => a + sl.value, 0);

  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const rings: Child[] = [];

  slices.forEach((sl, i) => {
    if (sl.value <= 0 || total <= 0) return;
    const frac = sl.value / total;
    const len = frac * circumference;
    rings.push(
      s('circle', {
        cx: r,
        cy: r,
        r: radius,
        fill: 'none',
        stroke: sl.color ?? paletteAt(i),
        'stroke-width': thickness,
        'stroke-dasharray': `${len.toFixed(2)} ${(circumference - len).toFixed(2)}`,
        'stroke-dashoffset': (-offset).toFixed(2),
        transform: `rotate(-90 ${r} ${r})`,
      }, s('title', {}, `${sl.label}　${(frac * 100).toFixed(2)}%　${moneyShort(sl.value)}`)),
    );
    offset += len;
  });

  const svg = s(
    'svg',
    { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': '结构占比图' },
    total <= 0 ? s('circle', { cx: r, cy: r, r: radius, fill: 'none', stroke: '#efe6d6', 'stroke-width': thickness }) : null,
    ...rings,
    s('text', { x: r, y: r - 2, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 650, fill: '#241f19' }, opts.centerLabel ?? ''),
    s('text', { x: r, y: r + 14, 'text-anchor': 'middle', 'font-size': 10, fill: '#8b8073' }, opts.unit ?? ''),
  );

  const legend = h(
    'div',
    { class: 'legend' },
    ...slices.map((sl, i) =>
      h(
        'span',
        { class: 'legend__item' },
        h('i', { class: 'legend__dot', style: { background: sl.color ?? paletteAt(i) } }),
        `${sl.label} ${total > 0 ? ((sl.value / total) * 100).toFixed(1) : '0.0'}%`,
      ),
    ),
  );

  return h('div', {}, h('div', { style: { display: 'flex', justifyContent: 'center' } }, svg), legend);
}

/** 横向条形列表（原生 HTML，便于放数字与角标） */
export function barList(
  items: readonly { label: string; value: number; display?: string; note?: Child; color?: string }[],
  opts: { max?: number } = {},
): HTMLElement {
  const max = opts.max ?? Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return h(
    'div',
    { class: 'bars' },
    ...items.map((it, i) =>
      h(
        'div',
        { class: 'bar-row' },
        h('span', { class: 'bar-row__label', title: it.label }, it.label),
        h(
          'span',
          { class: 'bar-row__track' },
          h('i', {
            class: 'bar-row__fill',
            style: {
              width: `${Math.min(100, (Math.abs(it.value) / max) * 100).toFixed(1)}%`,
              background: it.color ?? paletteAt(i),
            },
          }),
        ),
        h('span', { class: 'bar-row__val' }, it.display ?? moneyShort(it.value), it.note ?? null),
      ),
    ),
  );
}

export interface DropStep {
  step: string;
  /** 增减额（正负） */
  value: number;
  /** 该步后的累计余额 */
  cumulative: number;
  subtotal: boolean;
  kind: 'revenue' | 'cost' | 'tax' | 'profit';
}

/**
 * 瀑布图 —— 直接消费内核 `TaxScenarioResult.waterfall`。
 *
 * 内核已给出每一步的 `cumulative`，前端**不得**再自己累加
 * （V9 的瀑布图对不上正是因为把"利润总额"当成一个正的增量行重复累加）。
 */
export function waterfallChart(steps: readonly DropStep[], opts: { height?: number } = {}): SVGElement {
  const H = opts.height ?? 230;
  const W = 680;
  const pad = { top: 16, right: 12, bottom: 46, left: 56 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;

  const positives = steps.map((st) => Math.max(st.cumulative, st.cumulative - st.value, 0));
  const top = Math.max(1, ...positives) * 1.08;
  const bw = Math.min(64, (iw / Math.max(1, steps.length)) * 0.62);
  const slot = iw / Math.max(1, steps.length);
  const y = (v: number) => pad.top + ih - (Math.max(0, v) / top) * ih;

  const COLOR: Record<DropStep['kind'], string> = {
    revenue: '#3f7d54',
    cost: '#c98a1f',
    tax: '#b3261e',
    profit: '#4a6580',
  };

  const nodes: Child[] = [];
  steps.forEach((st, i) => {
    const cx = pad.left + slot * i + slot / 2;
    const x0 = cx - bw / 2;
    const from = st.subtotal ? 0 : st.cumulative - st.value;
    const to = st.cumulative;
    const yTop = y(Math.max(from, to));
    const hgt = Math.max(2, Math.abs(y(from) - y(to)));
    nodes.push(
      s(
        'g',
        {},
        s('rect', {
          x: x0.toFixed(1),
          y: yTop.toFixed(1),
          width: bw.toFixed(1),
          height: hgt.toFixed(1),
          rx: 3,
          fill: COLOR[st.kind],
          opacity: st.subtotal ? 0.95 : 0.8,
        }, s('title', {}, `${st.step}　${moneyShort(st.value)}　余额 ${moneyShort(st.cumulative)}`)),
        s(
          'text',
          { x: cx.toFixed(1), y: (yTop - 5).toFixed(1), 'text-anchor': 'middle', 'font-size': 10, fill: '#5f564a' },
          moneyShort(st.cumulative),
        ),
        s(
          'text',
          {
            x: cx.toFixed(1),
            y: H - 28,
            'text-anchor': 'end',
            'font-size': 10,
            transform: `rotate(-38 ${cx.toFixed(1)} ${H - 28})`,
          },
          st.step,
        ),
      ),
    );
    if (i > 0) {
      const px = pad.left + slot * (i - 1) + slot / 2 + bw / 2;
      nodes.push(
        s('line', {
          x1: px.toFixed(1),
          x2: (cx - bw / 2).toFixed(1),
          y1: y(steps[i - 1]!.cumulative).toFixed(1),
          y2: y(st.cumulative).toFixed(1),
          stroke: '#d3c5ad',
          'stroke-width': 1,
          'stroke-dasharray': '2 3',
        }),
      );
    }
  });

  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) =>
    s('g', {}, s('line', {
      x1: pad.left,
      x2: pad.left + iw,
      y1: y(top * t).toFixed(1),
      y2: y(top * t).toFixed(1),
      stroke: '#e3d9c8',
      'stroke-width': 1,
      'stroke-dasharray': t === 0 ? '0' : '3 4',
    }), s('text', { x: pad.left - 7, y: (y(top * t) + 3.5).toFixed(1), 'text-anchor': 'end' }, moneyShort(top * t))),
  );

  return s(
    'svg',
    { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '税后利润瀑布图', preserveAspectRatio: 'xMidYMid meet' },
    ...grid,
    ...nodes,
  );
}
