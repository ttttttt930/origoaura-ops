/**
 * L6 · ui/dom —— 极简 DOM 构造器
 *
 * 刻意不引入任何框架：V10 是单文件产物的静态站点（C6），
 * 框架带来的体积与构建复杂度换不来对应的收益。所有视图都是纯函数：
 *   (数据) → HTMLElement
 * 状态变更时整体重渲染，避免"局部更新漏了一处"这类隐蔽 bug。
 */

/** 允许直接传数组（map 出来的节点列表无需展开） */
export type Child = Node | string | number | null | undefined | false | Child[];

import { money } from './format.ts';

type Attrs = Record<string, unknown>;

function applyAttrs(el: Element, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') {
      el.setAttribute('class', String(v));
    } else if (k === 'style' && typeof v === 'object' && v !== null) {
      Object.assign((el as HTMLElement).style, v as Partial<CSSStyleDeclaration>);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'dataset' && typeof v === 'object' && v !== null) {
      for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) {
        if (dv !== null && dv !== undefined) el.setAttribute(`data-${dk}`, String(dv));
      }
    } else if (k === 'text') {
      el.textContent = String(v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

/** parent 可以是 Element 或 DocumentFragment —— 两者的 API 差异只在属性上，这里用不到 */
function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) {
      append(parent, c);
    } else if (typeof c === 'string' || typeof c === 'number') {
      parent.appendChild(document.createTextNode(String(c)));
    } else {
      parent.appendChild(c);
    }
  }
}

/** HTML 元素构造 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG 元素构造（必须用命名空间，createElement 产出的是 HTML 元素） */
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(host: Element, node: Node): void {
  clear(host);
  host.appendChild(node);
}

/* ------------------------------------------------------------ 常用片段 */

export function card(...children: Child[]): HTMLElement {
  return h('section', { class: 'card' }, ...children);
}

export function sectionHead(title: string, hint?: Child): HTMLElement {
  return h('div', { class: 'section__head' }, h('h3', {}, title), hint ? h('span', {}, hint) : null);
}

/** 大数字卡（驾驶舱 hero） */
export function heroCardShell(
  title: string,
  value: Child,
  sub: Child,
  opts: { tone?: 'safe' | 'warning' | 'loss'; extra?: Child } = {},
): HTMLElement {
  return h(
    'section',
    { class: `card hero${opts.tone ? ` hero--${opts.tone}` : ''}` },
    h('p', { class: 'card__title' }, title),
    h('div', { class: 'hero__value' }, value, opts.extra ?? null),
    h('p', { class: 'hero__sub' }, sub),
  );
}

export function badge(text: Child, kind?: 'ok' | 'warn' | 'danger' | 'info' | 'accent'): HTMLElement {
  return h('span', { class: `badge${kind ? ` badge--${kind}` : ''}` }, text);
}

export function tag(text: Child, kind?: 'est' | 'alloc' | 'ok' | 'off'): HTMLElement {
  return h('span', { class: `tag${kind ? ` tag--${kind}` : ''}` }, text);
}

/** 表格：cols 为表头，rows 为二维节点数组 */
export function table(caption: Child | null, cols: string[], rows: Child[][], opts: { align?: string } = {}): HTMLElement {
  return h(
    'div',
    { class: 'tablewrap' },
    h(
      'table',
      { class: 'tbl' },
      caption ? h('caption', {}, caption) : null,
      h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', {}, c)))),
      h(
        'tbody',
        {},
        ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', { class: opts.align ?? '' }, c)))),
      ),
    ),
  );
}

/** 数据缺口空态（ADR-08：结构化缺口 → 渲染空态 + 三步入手指引，绝不补 0） */
export function emptyState(title: string, message: string, steps: string[], icon = '🧩'): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty__ico' }, icon),
    h('h4', { class: 'empty__title' }, title),
    h('p', { class: 'empty__msg' }, message),
    h(
      'ol',
      { class: 'empty__steps' },
      ...steps.map((st) => h('li', {}, ...inlineCode(st))),
    ),
  );
}

/** 把反引号片段转成 <code>（只支持行内 code，够用了） */
function inlineCode(text: string): Child[] {
  return text.split('`').map((seg, i) => (i % 2 === 1 ? h('code', {}, seg) : seg));
}

export function notes(items: readonly string[]): HTMLElement {
  return h('ul', { class: 'notes' }, ...items.map((t) => h('li', {}, ...inlineCode(t))));
}

export function kv(pairs: readonly [string, Child][]): HTMLElement {
  return h(
    'dl',
    { class: 'kv' },
    ...pairs.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
  );
}

export function collapsible(summary: string, content: Child): HTMLElement {
  return h('details', { class: 'raw' }, h('summary', {}, summary), content);
}

/* ------------------------------------------------------------ 数字着色 */

/** 中国股市约定：涨=红，跌=绿 */
export function deltaChip(pct: number | null, suffix = '%'): Child {
  if (pct === null || !Number.isFinite(pct)) return h('span', { class: 'delta delta--flat' }, '—');
  const cls = pct > 0 ? 'delta--up' : pct < 0 ? 'delta--down' : 'delta--flat';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '＝';
  return h('span', { class: `delta ${cls}` }, `${arrow} ${Math.abs(pct).toFixed(1)}${suffix}`);
}

export function coloredMoney(v: number): Child {
  const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'muted';
  return h('span', { class: cls }, money(v));
}

export { money, moneyShort, num, days, formatRatio, formatPct, formatInt } from './format.ts';
