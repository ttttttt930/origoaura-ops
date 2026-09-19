/**
 * L6 · views/shared —— 各视图共用的取值与装饰
 *
 * 铁律：这里**只做取数与排版**，不做任何业务计算。
 * 每一个数字都必须来自 @origo/core 的选择器（SAD §8），
 * 一旦在这里出现 `revenue - refund - promotion` 之类的式子就是违规。
 */

import {
  aggregatePeriod,
  buildAlerts,
  channelBreakdown,
  inventoryCoverage,
  type Alert,
  type ChannelReport,
  type InventoryCoverage,
  type PeriodResult,
} from '@origo/core';
import type { AppState } from '../state.ts';
import { lastActiveDate } from '../data/load.ts';
import { h, badge, notes, type Child } from '../ui/dom.ts';
import { formatPct, num } from '../ui/format.ts';

export function periodResult(state: AppState): PeriodResult {
  return aggregatePeriod(state.snapshot.daily, state.period, state.today, state.snapshot.skuMaster);
}

export function channelReport(state: AppState, window: PeriodResult['window']): ChannelReport {
  return channelBreakdown(state.snapshot.daily, window, state.snapshot.skuMaster);
}

export function alerts(state: AppState): Alert[] {
  const r = periodResult(state);
  const ch = channelReport(state, r.window);
  const cov = coverage(state);
  return buildAlerts({
    period: r,
    channels: ch,
    ...(cov ? { inventory: cov } : {}),
    ...(state.snapshot.targets ? { targets: state.snapshot.targets } : {}),
    daily: state.snapshot.daily,
  });
}

/**
 * 库存覆盖（供应链页与预警共用）。
 * 库存主数据缺失 → 返回 null（不是空数组），调用方据此渲染空态，绝不补 0（ADR-08）。
 */
export function coverage(state: AppState): InventoryCoverage[] | null {
  const items = state.snapshot.inventory;
  if (!items || !items.length) return null;
  return inventoryCoverage(items, state.snapshot.skuDaily, { today: state.today });
}

/** 顶部状态条：让"这份数据有多可信 / 多新鲜"始终可见 */
export function headBadges(state: AppState): HTMLElement {
  const s = state.snapshot;
  const dq = s.dqReport;
  const badChecksums = state.load.checksumResults.filter((c) => !c.ok).length;
  const asOf = lastActiveDate(s);

  return h(
    'div',
    { class: 'badges' },
    badge(h('span', {}, '快照 ', h('b', {}, s.generatedAt.slice(0, 10)), ` ${s.generatedAt.slice(11, 16)}Z`)),
    asOf ? badge(h('span', {}, '数据截至 ', h('b', {}, asOf))) : null,
    badge(h('span', {}, 'schema ', h('b', {}, s.schemaVersion)), 'accent'),
    dq.passed
      ? badge(h('span', {}, `DQ 通过 · ${dq.rulesRun} 条规则`), 'ok')
      : badge(h('span', {}, `DQ 未过 · ${dq.blockCount} block / ${dq.warnCount} warn`), 'danger'),
    badChecksums === 0
      ? badge(h('span', {}, `校验和 ${state.load.checksumResults.length}/${state.load.checksumResults.length} 一致`), 'ok')
      : badge(h('span', {}, `校验和异常 ${badChecksums} 处`), 'danger'),
    state.load.migrated
      ? badge(h('span', {}, `已迁移 ${state.load.sourceSchemaVersion} → ${state.load.frontendSchemaVersion}`), 'warn')
      : null,
  );
}

/** 页脚口径声明（C7：估算/分摊/未计入必须如实标注，不藏在文档里） */
export function caveats(state: AppState): Child {
  const p = state.snapshot.costPolicy;
  const items: string[] = [
    '净收入一律由内核重算（营收 − 退款 − 推广），不读源表里的净收入公式 —— 7 月事故正源于此。',
    '物料成本按「综合单瓶成本 × 销量」，综合单瓶成本是**按预估月销加权**的估算值，界面已打「估算」角标。',
    `增值税为价外税，不进入损益表；损益类税金只含附加税费与印花税。`,
  ];
  if (!p.fillingPerUnit) items.push('灌装成本尚未取数，按 0 参与计算 —— 实际毛利会低于本页数值。');
  if (!p.laborPerUnit) items.push('人工成本尚未取数，按 0 参与计算。');
  if (!p.packagingLossRate) items.push('包材损耗率尚未取数，按 0 参与计算。');
  const placeholder = state.snapshot.skuMaster.filter((x) => x.bomSource === 'placeholder').length;
  if (placeholder > 0) {
    items.push(`${placeholder} 款 SKU 的 BOM 明细为占位结构（仅单位成本为实采值），供应商集中度可参考、逐组件核价不可用。`);
  }
  if (!state.snapshot.skuDaily.length) {
    items.push('尚无「商品 × 平台 × 日」数据，单页毛利与库存覆盖只能显示空态；补齐后本看板自动填充。');
  }
  items.push('快照加密仅防明文抓取，不构成权限隔离（ADR-06）。');
  return notes(items);
}

/** 平台列口径说明（避免"为何有的平台是 0"被误解为数据丢失） */
export function platformCaveat(ch: ChannelReport): Child {
  const inactive = ch.channels.filter((c) => !c.active);
  if (!inactive.length) return null;
  return notes([
    `本期 ${inactive.map((c) => c.label).join('、')} 无数据。可能是尚未开通，也可能是未导入 —— 界面保留这些行并标灰，而不是把缺数据的渠道悄悄隐藏成 0（C4：4→5 平台演进）。`,
    `当前活跃平台 ${ch.activePlatforms} 个，营收合计 ${formatPct(100, 0)}（HHI ${ch.hhi}）。`,
  ]);
}

export function periodStrip(r: PeriodResult): HTMLElement {
  const w = r.window;
  const bits = [
    h('span', {}, `区间 ${w.start} ~ ${w.end}`),
    h('span', {}, ` 有数据 `, h('b', {}, num(w.observedDays)), `/${w.calendarDays} 天`),
  ];
  if (w.blankDays > 0) {
    bits.push(h('span', { class: 'dim' }, ` （含 ${w.blankDays} 个无数据日）`));
  }
  return h('p', { class: 'card__note' }, ...bits);
}
