/**
 * L4 · config/loadMaster —— 主数据加载（ADR-09：口径外置，改数据不改代码）
 *
 * 全部主数据都放在 data/master/ 下，缺失时给出**带默认值与提示**的结果，
 * 绝不静默用代码里的魔法数兜底（否则就退化成 V9 的"三轨成本口径"）。
 */

import { readFileSync } from 'node:fs';
import { masterPath, type MasterFileName } from './paths.ts';
import type { CostPolicy, InventoryItem, SkuMaster, TaxParams } from '@origo/core';

export interface LoadResult<T> {
  value: T;
  /** 文件是否存在 */
  found: boolean;
  /** 加载过程中的提示（缺失字段、使用默认值等），CLI 会原样打印 */
  notes: string[];
}

function readJson<T>(file: MasterFileName): LoadResult<T | null> {
  const path = masterPath(file);
  try {
    const raw = readFileSync(path, 'utf8');
    return { value: JSON.parse(raw) as T, found: true, notes: [] };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return { value: null, found: false, notes: [`缺少主数据文件 ${file}，将使用保守默认值。`] };
    }
    throw new Error(`解析主数据 ${file} 失败：${e.message}`);
  }
}

/** 去掉以 `_` 开头的说明性字段（_readme 等），避免它们混进业务对象 */
function stripMeta<T extends object>(obj: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out as T;
}

/** 允许两种文件形态：裸数组（老格式）或 { items, _readme, ... }（可带元信息） */
interface SkuFileShape {
  items?: SkuMaster[];
  bomSource?: SkuMaster['bomSource'];
  costBasis?: string;
  _readme?: string;
}

/** SKU 主数据 —— 缺失时返回空数组（上游会转成 DataGap，不编造 SKU） */
export function loadSkuMaster(): LoadResult<SkuMaster[]> {
  const r = readJson<SkuMaster[] | SkuFileShape>('sku-bom.json');
  if (!r.value) {
    return {
      value: [],
      found: false,
      notes: ['缺少 sku-bom.json：单品毛利页将显示"数据缺口"空态，不会用占位 SKU 顶替。'],
    };
  }

  const shape = r.value as SkuFileShape;
  const raw = Array.isArray(r.value) ? r.value : (shape.items ?? []);
  // 文件级默认值下沉到每一条，避免上层再判一次
  const items: SkuMaster[] = raw.map((s) => ({
    ...s,
    ...(s.costBasis ?? shape.costBasis ? { costBasis: s.costBasis ?? shape.costBasis } : {}),
    ...(s.bomSource ?? shape.bomSource ? { bomSource: s.bomSource ?? shape.bomSource } : {}),
  }));

  const notes: string[] = [];
  if (!items.length) notes.push('sku-bom.json 里没有任何 SKU。');
  for (const s of items) {
    if (!s.costBasis) notes.push(`SKU「${s.sku}」未标注 costBasis（成本口径版本），历史对比可能失真。`);
    if (s.unitCost === undefined || s.unitCost === null) notes.push(`SKU「${s.sku}」缺少 unitCost。`);
  }
  const placeholder = items.filter((s) => s.bomSource === 'placeholder').length;
  if (placeholder) {
    notes.push(
      `${placeholder} 款 SKU 的 BOM 明细标记为 placeholder（占位结构）：` +
        `供应商集中度可参考，逐组件核价不可用（C7 假数据标注）。`,
    );
  }
  return { value: items, found: true, notes };
}

/** 成本口径 —— 缺失时三项主成本记 0 并在界面标注「未计入」 */
export function loadCostPolicy(): LoadResult<CostPolicy> {
  const r = readJson<CostPolicy>('platform-fees.json');
  const fallback: CostPolicy = {
    platformCommissionRate: { taobao: 0, douyin: 0, xiaohongshu: 0, tiktok: 0, pdd: 0 },
    paymentFeeRate: 0,
    logisticsPerOrder: 0,
    fillingPerUnit: 0,
    laborPerUnit: 0,
    packagingLossRate: 0,
    note: 'platform-fees.json 缺失，平台扣点/支付费率/物流单价均按 0 参与计算，界面须标注「未计入」。',
  };
  if (!r.value) return { value: fallback, found: false, notes: r.notes };
  return { value: { ...fallback, ...stripMeta(r.value) }, found: true, notes: [] };
}

/** 税务参数 —— 这是合规相关，缺失时**拒绝构建**（不给默认税率） */
export function loadTaxParams(): LoadResult<TaxParams | null> {
  const r = readJson<TaxParams>('tax-rates.json');
  if (!r.value) {
    return {
      value: null,
      found: false,
      notes: ['缺少 tax-rates.json：税务页需要明确的政策参数，拒绝用猜测税率计算（ADR-09）。'],
    };
  }
  const notes: string[] = [];
  if (!r.value.policyValidUntil) notes.push('tax-rates.json 未标注 policyValidUntil（政策有效期），界面无法提示税率时效。');
  return { value: stripMeta(r.value), found: true, notes };
}

export function loadTargets(): LoadResult<Record<string, number | null> | null> {
  const r = readJson<Record<string, number | null>>('targets.json');
  if (!r.value) return r;
  // null 表示"未设置"，保留 null 语义（不要变 0，否则会算出一个假的 0% 达成率）
  return { value: stripMeta(r.value), found: true, notes: [] };
}

/** 库存：支持裸数组或 { items: [] } 两种形态 */
export function loadInventory(): LoadResult<InventoryItem[]> {
  const r = readJson<InventoryItem[] | { items?: InventoryItem[]; asOfDefault?: string }>('inventory.json');
  if (!r.value) return { value: [], found: false, notes: [] };
  const shape = r.value as { items?: InventoryItem[]; asOfDefault?: string };
  const raw = Array.isArray(r.value) ? r.value : (shape.items ?? []);
  const items = raw.map((it) => ({
    ...it,
    ...(it.asOf ?? shape.asOfDefault ? { asOf: it.asOf ?? shape.asOfDefault! } : {}),
  }));
  const notes: string[] = [];
  if (!items.length) notes.push('inventory.json 里没有库存记录，供应链页将显示空态。');
  return { value: items, found: true, notes };
}

/** 已知差异留痕（ruleId|scope → 备注），DQ 执行时注入 */
export function loadAcknowledged(): LoadResult<Record<string, string>> {
  const r = readJson<Record<string, string>>('dq-acknowledged.json');
  if (!r.value) return { value: {}, found: false, notes: [] };
  const entries = Object.entries(stripMeta(r.value)).filter(([, v]) => typeof v === 'string');
  return { value: Object.fromEntries(entries), found: true, notes: [] };
}
