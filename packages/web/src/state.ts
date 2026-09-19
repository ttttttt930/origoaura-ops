/**
 * L6 · state —— 表现层状态与视图契约
 *
 * 这里只放"界面状态"（当前视图、当前时间口径、快照引用），
 * **不放任何业务量**：所有指标一律由视图调用 @origo/core 的选择器现算（SAD §8）。
 */

import type { PeriodKind, Snapshot } from '@origo/core';
import type { LoadResult } from './data/load.ts';

export const VIEWS = ['dashboard', 'channels', 'product', 'supply', 'finance', 'quality'] as const;
export type ViewId = (typeof VIEWS)[number];

export interface ViewMeta {
  id: ViewId;
  label: string;
  icon: string;
  group: string;
  /** 该视图是否消费时间口径（质量中心/供应链的部分区块不需要） */
  usesPeriod: boolean;
  blurb: string;
}

export const VIEW_META: readonly ViewMeta[] = [
  {
    id: 'dashboard',
    label: '经营驾驶舱',
    icon: '◎',
    group: '分析',
    usesPeriod: true,
    blurb: '四张核心卡 + 智能预警 + 营收趋势，一眼看清当日/当周/当月经营位置。',
  },
  {
    id: 'channels',
    label: '渠道结构',
    icon: '◈',
    group: '分析',
    usesPeriod: true,
    blurb: '五平台营收结构、退款与推广效率、渠道集中度（HHI）与单渠道依赖风险。',
  },
  {
    id: 'product',
    label: '产品 SKU',
    icon: '❖',
    group: '分析',
    usesPeriod: true,
    blurb: '按 SKU × 平台逐行计算真实毛利（真实 BOM 成本），不再用等权估算。',
  },
  {
    id: 'supply',
    label: '供应链库存',
    icon: '▤',
    group: '经营',
    usesPeriod: false,
    blurb: '库存覆盖天数、补货建议、供应商集中度与 BOM 结构可信度。',
  },
  {
    id: 'finance',
    label: '财务税务',
    icon: '¥',
    group: '经营',
    usesPeriod: true,
    blurb: '增值税 → 附加税费 → 印花税 → 所得税 → 分红 全链路，瀑布图可直接逐笔累加。',
  },
  {
    id: 'quality',
    label: '数据质量中心',
    icon: '✓',
    group: '经营',
    usesPeriod: false,
    blurb: '11 条勾稽规则的执行结果、快照指纹与版本协商记录 —— 数据可信度的证据链。',
  },
];

export const PERIOD_LABEL: Record<PeriodKind, string> = {
  today: '日报',
  week: '周报',
  month: '月报',
  year: '年报',
  all: '全期',
};

export const PERIOD_ORDER: readonly PeriodKind[] = ['today', 'week', 'month', 'year', 'all'];

export interface AppState {
  snapshot: Snapshot;
  load: LoadResult;
  /** 注入给内核的"今天"（内核不取当前时间） */
  today: string;
  period: PeriodKind;
  view: ViewId;
}

export interface ViewContext {
  state: AppState;
  setView(v: ViewId): void;
  setPeriod(p: PeriodKind): void;
  /** 重新解密装载（用于"刷新数据"） */
  reload(): void;
  /**
   * 只重画当前视图（用于页面内的情景开关，如纳税人身份 / 分红比例）。
   * 与 reload 的区别：不重新解密、不重新取数，纯界面重渲染。
   */
  rerender(): void;
}

export function viewMeta(id: ViewId): ViewMeta {
  return VIEW_META.find((v) => v.id === id) ?? VIEW_META[0]!;
}
