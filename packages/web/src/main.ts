/**
 * L6 · main —— 入口：解锁 → 装载 → 启动
 *
 * 凭据处理说明（ADR-06）：
 *   · 口令**不内置**在产物里，由使用者输入；
 *   · 会话内缓存在 sessionStorage（关标签即失效，不落 localStorage）；
 *   · 但必须如实标注：静态站点的产物终归是公开的，解密只防"明文直接抓取"，
 *     不构成权限隔离。真正的权限隔离要到 V12 引入服务端鉴权。
 */

import './styles.css';
import { h, mount } from './ui/dom.ts';
import { LoadError, loadSnapshot, todayIso } from './data/load.ts';
import { applyStoredTheme, bootApp, PW_KEY } from './app.ts';
import type { AppState } from './state.ts';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('缺少 #app 挂载点');

// 首帧前落皮肤，避免先闪一下默认色再跳到用户选的那套
applyStoredTheme();

function bootShell(): void {
  root!.innerHTML = '';
  root!.appendChild(h('div', { class: 'boot' }, h('div', { class: 'boot__ring' }), h('p', {}, '正在解密并校验快照…')));
}

function renderFatal(title: string, message: string, hint?: string): void {
  mount(
    root!,
    h(
      'div',
      { class: 'lock' },
      h(
        'div',
        { class: 'lock__card' },
        h('p', { class: 'lock__brand' }, 'OrigoAura 经营看板 V10'),
        h('h2', { class: 'lock__title' }, title),
        h('p', { class: 'lock__sub' }, message),
        hint ? h('p', { class: 'lock__msg lock__msg--info' }, hint) : null,
        h(
          'button',
          {
            class: 'lock__btn',
            style: { marginTop: '18px', width: '100%' },
            onclick: () => {
              sessionStorage.removeItem(PW_KEY);
              renderLock();
            },
          },
          '返回解锁',
        ),
      ),
    ),
  );
}

function renderLock(errMsg?: string): void {
  const input = h('input', {
    class: 'lock__input',
    id: 'lockPw',
    type: 'password',
    placeholder: '请输入快照解锁口令',
    autocomplete: 'off',
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') submit();
    },
  });

  const btn = h('button', { class: 'lock__btn', onclick: () => submit() }, '解锁看板');
  const msg = h('p', { class: 'lock__msg', style: errMsg ? {} : { display: 'none' } }, errMsg ?? '');

  async function submit(): Promise<void> {
    const pw = input.value.trim();
    if (!pw) {
      msg.textContent = '请输入口令。';
      msg.style.display = '';
      return;
    }
    btn.disabled = true;
    btn.textContent = '解密中…';
    msg.style.display = 'none';
    try {
      const load = await loadSnapshot(pw);
      sessionStorage.setItem(PW_KEY, pw);
      const state: AppState = {
        snapshot: load.snapshot,
        load,
        today: todayIso(),
        period: 'month',
        view: 'dashboard',
      };
      bootShell();
      bootApp({ root: root!, state, reload: () => location.reload() });
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '解锁看板';
      msg.style.display = '';
      if (e instanceof LoadError) {
        msg.textContent = e.kind === 'password' ? `口令不正确：${e.message}` : e.message;
        if (e.detail) {
          msg.textContent += `（${e.detail}）`;
        }
      } else {
        msg.textContent = (e as Error).message;
      }
      input.select();
    }
  }

  mount(
    root!,
    h(
      'div',
      { class: 'lock' },
      h(
        'div',
        { class: 'lock__card' },
        h('p', { class: 'lock__brand' }, 'OrigoAura · 时法'),
        h('h1', { class: 'lock__title' }, '经营看板 V10'),
        h('p', { class: 'lock__sub' }, '数据为加密快照，需要口令解密后才能查看。'),
        h('div', { class: 'lock__row' }, input, btn),
        msg,
        h(
          'p',
          { class: 'lock__note' },
          '算法：AES-256-GCM / PBKDF2-SHA256 × 150,000。解密后会逐项复核分区校验和，结果在「数据质量中心」可见。',
          h('br'),
          'ADR-06 局限：密钥最终随产物分发，加密只防「明文直接抓取」，不构成权限隔离；真权限隔离在 V12。',
        ),
      ),
    ),
  );
  input.focus();
}

async function main(): Promise<void> {
  const cached = sessionStorage.getItem(PW_KEY);
  if (cached) {
    try {
      const load = await loadSnapshot(cached);
      const state: AppState = {
        snapshot: load.snapshot,
        load,
        today: todayIso(),
        period: 'month',
        view: 'dashboard',
      };
      bootApp({ root: root!, state, reload: () => location.reload() });
      return;
    } catch {
      sessionStorage.removeItem(PW_KEY);
    }
  }
  renderLock();
}

main().catch((e: unknown) => {
  const err = e as LoadError;
  if (err instanceof LoadError && err.kind === 'network') {
    renderFatal(
      '读不到数据文件',
      err.message,
      '请确认 packages/web/public/marketing-data.latest.json 已随站点一起发布。',
    );
    return;
  }
  renderFatal('初始化失败', (e as Error).message);
});
