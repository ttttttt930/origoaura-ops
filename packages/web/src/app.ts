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

function shell(s: AppState): HTMLElement {
  const meta = viewMeta(s.view);
  const pick = (v: ViewId): void => ctx().setView(v);

  // 顶部栏（飞书风）：蓝色方形 logo + 标题 + 右侧动作
  const topbar = h(
    'header',
    { class: 'ttop' },
    h('div', { class: 'tt-logo' }, 'OA'),
    h(
      'div',
      { class: 'tt-titles' },
      h('div', { class: 't1' }, 'OrigoAura 经营看板'),
      h('div', { class: 't2' }, `v10 · single source of truth · 快照 ${s.snapshot.generatedAt.slice(0, 10)}`),
    ),
    h(
      'div',
      { class: 'tt-actions' },
      h(
        'button',
        {
          class: 'btn',
          title: '在 classic（飞书蓝）与 warm（米金暖调）之间切换',
          onclick: () => {
            const cur = document.documentElement.getAttribute('data-theme');
            const next = cur === 'warm' ? 'classic' : 'warm';
            document.documentElement.setAttribute('data-theme', next);
            try {
              localStorage.setItem(THEME_KEY, next);
            } catch {
              /* 隐私模式下 localStorage 不可用，忽略即可 */
            }
          },
        },
        '🎨 换肤',
      ),
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            sessionStorage.removeItem(PW_KEY);
            reloadFn();
          },
        },
        '换口令 / 重新解锁',
      ),
    ),
  );

  // 模块导航：横向 tab（沿用 V9 老看板的信息架构）
  const modnav = h(
    'nav',
    { class: 'modnav' },
    ...VIEW_META.map((v) =>
      h(
        'a',
        {
          class: v.id === s.view ? 'on' : '',
          dataset: { mod: v.id },
          href: `#/${v.id}`,
          onclick: (e: Event) => {
            e.preventDefault();
            pick(v.id);
          },
        },
        h('span', { class: 'ico' }, v.icon),
        h('span', {}, v.label),
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
    { class: 'content' },
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h2', {}, meta.label),
        h('p', {}, meta.blurb),
      ),
      chips,
    ),
    headBadges(s),
    h('div', { class: 'view' }, RENDERERS[s.view](ctx())),
  );

  return h('div', { class: 'app-root' }, topbar, modnav, main);
}

/** 会话内缓存口令，刷新页面不必重复输入（不落 localStorage，关标签即失效） */
export const PW_KEY = 'origo.snapshot.password';
/** 皮肤偏好（classic / warm），落 localStorage；不可用时退回默认 classic */
export const THEME_KEY = 'origo.theme';

/** 在首帧前应用皮肤，避免闪一下默认色再跳到暖调 */
export function applyStoredTheme(): void {
  let theme = 'classic';
  try {
    theme = localStorage.getItem(THEME_KEY) ?? 'classic';
  } catch {
    /* 隐私模式：保持默认 */
  }
  document.documentElement.setAttribute('data-theme', theme);
}
