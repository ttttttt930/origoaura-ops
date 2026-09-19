/**
 * L6 · app —— 外壳、路由与重渲染
 *
 * 采用"整体重渲染"而不是细粒度更新：数据量只有几千行，
 * 全量重画的代价远低于"局部更新漏了一处"带来的口径不一致风险。
 *
 * 路由用 hash（#/dashboard），因为静态站点没有服务端重写规则（C6）。
 */

import {
  PERIOD_LABEL,
  PERIOD_ORDER,
  VIEW_META,
  viewMeta,
  type AppState,
  type ViewContext,
  type ViewId,
} from './state.ts';
import { h, mount } from './ui/dom.ts';
import { headBadges } from './views/shared.ts';
import { renderDashboard } from './views/dashboard.ts';
import { renderChannels } from './views/channels.ts';
import { renderProduct } from './views/product.ts';
import { renderSupply } from './views/supply.ts';
import { renderFinance } from './views/finance.ts';
import { renderQuality } from './views/quality.ts';

let state: AppState | null = null;
let host: HTMLElement | null = null;
let reloadFn: () => void = () => {};

const RENDERERS: Record<ViewId, (ctx: ViewContext) => Node> = {
  dashboard: renderDashboard,
  channels: renderChannels,
  product: renderProduct,
  supply: renderSupply,
  finance: renderFinance,
  quality: renderQuality,
};

export function bootApp(opts: { root: HTMLElement; state: AppState; reload(): void }): void {
  host = opts.root;
  state = opts.state;
  reloadFn = opts.reload;

  // 允许用 #/finance 直达，也允许刷新时保持当前视图
  const fromHash = parseHash();
  if (fromHash) state.view = fromHash;

  window.addEventListener('hashchange', () => {
    const v = parseHash();
    if (v && state) {
      state.view = v;
      paint();
    }
  });

  paint();
}

function parseHash(): ViewId | null {
  const m = /^#\/([a-z]+)$/.exec(location.hash);
  if (!m) return null;
  const id = m[1] as ViewId;
  return VIEW_META.some((v) => v.id === id) ? id : null;
}

function ctx(): ViewContext {
  const s = state!;
  return {
    state: s,
    setView: (v) => {
      s.view = v;
      location.hash = `#/${v}`;
      paint();
    },
    setPeriod: (p) => {
      s.period = p;
      paint();
    },
    reload: () => reloadFn(),
    rerender: () => paint(),
  };
}

function paint(): void {
  if (!host || !state) return;
  mount(host, shell(state));
}

function navItem(id: ViewId, active: ViewId, onPick: (v: ViewId) => void): HTMLElement {
  const meta = viewMeta(id);
  return h(
    'button',
    {
      class: 'navitem',
      'aria-current': String(id === active),
      dataset: { mod: id },
      onclick: () => onPick(id),
    },
    h('span', { class: 'navitem__ico' }, meta.icon),
    h('span', {}, meta.label),
  );
}

function shell(s: AppState): HTMLElement {
  const meta = viewMeta(s.view);
  const pick = (v: ViewId): void => ctx().setView(v);

  const side = h(
    'aside',
    { class: 'side' },
    h(
      'div',
      { class: 'side__brand' },
      h('h1', {}, 'OrigoAura 经营看板'),
      h('p', {}, 'v10 · single source of truth'),
    ),
    ...grouped('分析', s.view, pick),
    ...grouped('经营', s.view, pick),
    h(
      'div',
      { class: 'side__foot' },
      h('div', {}, '口径全部来自 ', h('code', {}, '@origo/core')),
      h('div', {}, '界面不写业务公式'),
      h('div', {}, `快照 ${s.snapshot.generatedAt.slice(0, 10)}`),
      h(
        'div',
        { style: { marginTop: '8px' } },
        h(
          'button',
          {
            class: 'chip',
            onclick: () => {
              sessionStorage.removeItem(PW_KEY);
              reloadFn();
            },
          },
          '换口令 / 重新解锁',
        ),
      ),
    ),
  );

  const chips = meta.usesPeriod
    ? h(
        'div',
        { class: 'chips' },
        ...PERIOD_ORDER.map((p) =>
          h(
            'button',
            {
              class: 'chip',
              'aria-pressed': String(s.period === p),
              dataset: { period: p },
              onclick: () => ctx().setPeriod(p),
            },
            PERIOD_LABEL[p],
          ),
        ),
      )
    : null;

  const main = h(
    'main',
    { class: 'main' },
    h(
      'div',
      { class: 'topbar' },
      h(
        'div',
        { class: 'topbar__title' },
        h('h2', {}, meta.label),
        h('p', {}, meta.blurb),
      ),
      chips,
    ),
    headBadges(s),
    h('div', { class: 'view' }, RENDERERS[s.view](ctx())),
  );

  return h('div', { class: 'shell' }, side, main);
}

function grouped(group: string, active: ViewId, pick: (v: ViewId) => void): HTMLElement[] {
  const items = VIEW_META.filter((v) => v.group === group);
  if (!items.length) return [];
  return [h('div', { class: 'side__group' }, group), ...items.map((v) => navItem(v.id, active, pick))];
}

/** 会话内缓存口令，刷新页面不必重复输入（不落 localStorage，关标签即失效） */
export const PW_KEY = 'origo.snapshot.password';
