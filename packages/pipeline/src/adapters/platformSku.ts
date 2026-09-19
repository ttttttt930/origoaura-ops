/**
 * L4 · adapters/platformSku —— 平台「商品 × 日」明细 → SkuDaily[]
 *
 * 这是 PRD B 的前提数据。来源是各平台后台导出：
 *   淘宝生意参谋 → 商品 → 商品效果（商品 × 日）
 *   抖音电商罗盘 → 商品分析
 *   小红书千帆 / TikTok Shop Analytics / 拼多多商家后台
 *
 * 由于各平台列名不统一，这里用**别名表 + 可选 JSON 覆盖**的方式适配；
 * 一个文件只属于一个平台（平台后台不会跨平台导出），故平台需显式指定或从文件名推断。
 */

import { normalizeHeader, readSheet, type RawRow } from './xlsx.ts';
import { PLATFORMS, safeNumber, type Platform, type SkuDaily } from '@origo/core';

/** 各字段的候选列名（按优先级） */
export const SKU_ALIASES = {
  date: ['日期', '统计日期', '时间', 'date', '日期(YYYY-MM-DD)'],
  sku: ['商品名称', '商品', '商品标题', '宝贝名称', '商品名', 'SKU', 'sku'],
  qty: ['支付件数', '支付子订单数', '成交件数', '支付数量', '销量', '件数'],
  amount: ['支付金额', '支付金额(元)', '成交金额', '付款金额', '销售额', '支付金额（元）'],
  refundQty: ['退款件数', '退款数量', '退款子订单数'],
  refundAmount: ['退款金额', '退款金额(元)'],
  promotion: ['推广消耗', '推广费', '消耗', '投放金额', '花费'],
} as const;

export interface SkuIngestOptions {
  /** 平台；省略则从文件名推断 */
  platform?: Platform;
  sheet?: string;
  /** 手工指定列名（优先级最高） */
  columns?: Partial<Record<keyof typeof SKU_ALIASES, string>>;
}

export interface SkuIngestResult {
  rows: SkuDaily[];
  /** 该文件里出现的全部商品名（含未映射的，交给 DQ 报 warn） */
  observedSkus: string[];
  parsedColumns: string[];
  platform: Platform;
  notes: string[];
  source: string;
}

/** 从文件名推断平台 */
export function inferPlatform(fileName: string): Platform | null {
  const f = fileName.toLowerCase();
  if (/淘宝|天猫|taobao|tmall/.test(f)) return 'taobao';
  if (/抖音|抖店|douyin|doudian/.test(f)) return 'douyin';
  if (/小红书|千帆|xiaohongshu|xhs|redbook/.test(f)) return 'xiaohongshu';
  if (/tiktok|tik_tok|tik-tok/.test(f)) return 'tiktok';
  if (/拼多多|拼夕夕|pdd|pinduoduo/.test(f)) return 'pdd';
  return null;
}

function pick(headers: readonly string[], candidates: readonly string[], override?: string): string | null {
  if (override) {
    const key = normalizeHeader(override);
    return headers.includes(key) ? key : null;
  }
  for (const c of candidates) {
    const key = normalizeHeader(c);
    if (headers.includes(key)) return key;
  }
  return null;
}

/**
 * 解析单个平台导出文件。
 * 抛错条件：找不到商品列 / 件数列（没有这两列就无法计算单品毛利）。
 */
export function ingestPlatformSku(filePath: string, opts: SkuIngestOptions = {}): SkuIngestResult {
  const platform = opts.platform ?? inferPlatform(filePath);
  if (!platform || !PLATFORMS.includes(platform)) {
    throw new Error(
      `无法确定 ${filePath} 属于哪个平台。请在文件名里包含平台名（淘宝/抖音/小红书/tiktok/拼多多），` +
        `或用 --platform 显式指定。`,
    );
  }

  const sheet = readSheet(filePath, opts.sheet);
  const headers = sheet.headers.map(normalizeHeader);
  const headerMap = new Map<string, string>();
  sheet.headers.forEach((h, i) => headerMap.set(headers[i]!, h));

  const cols = {
    date: pick(headers, SKU_ALIASES.date, opts.columns?.date),
    sku: pick(headers, SKU_ALIASES.sku, opts.columns?.sku),
    qty: pick(headers, SKU_ALIASES.qty, opts.columns?.qty),
    amount: pick(headers, SKU_ALIASES.amount, opts.columns?.amount),
    refundQty: pick(headers, SKU_ALIASES.refundQty, opts.columns?.refundQty),
    refundAmount: pick(headers, SKU_ALIASES.refundAmount, opts.columns?.refundAmount),
    promotion: pick(headers, SKU_ALIASES.promotion, opts.columns?.promotion),
  };

  const notes: string[] = [];
  if (!cols.sku) throw new Error(`在 ${filePath} 中找不到商品名称列（候选：${SKU_ALIASES.sku.join('、')}）。`);
  if (!cols.qty) throw new Error(`在 ${filePath} 中找不到支付件数列（候选：${SKU_ALIASES.qty.join('、')}）。`);
  if (!cols.amount) notes.push('未找到支付金额列，成交均价将按 0 处理，单品收入会失真。');
  if (!cols.date) notes.push('未找到日期列，所有行按"未知日期"归入，仅可用于汇总不可用于日趋势。');
  if (!cols.refundQty && !cols.refundAmount) notes.push('未找到退款列，退款将按 0 处理。');
  if (!cols.promotion) notes.push('未找到单品推广列，推广费将走平台分摊（而不是直连）。');

  const rows: SkuDaily[] = [];
  const observed = new Set<string>();
  let skipped = 0;

  for (const raw of sheet.rows as RawRow[]) {
    const sku = String(raw[headerMap.get(cols.sku)!] ?? '').trim();
    if (!sku) {
      skipped += 1;
      continue;
    }
    const qty = safeNumber(raw[headerMap.get(cols.qty)!]);
    const amount = cols.amount ? safeNumber(raw[headerMap.get(cols.amount)!]) : 0;
    // 只统计发生了支付的 SKU×日；0 件的行直接不入库（避免污染均价）
    if (qty <= 0) continue;

    observed.add(sku);
    const date = cols.date ? String(raw[headerMap.get(cols.date)!] ?? '').trim() : '';
    rows.push({
      date: normalizeDateish(date),
      platform,
      sku,
      qty,
      avgPrice: Math.round((amount / qty + Number.EPSILON) * 100) / 100,
      refundQty: cols.refundQty ? safeNumber(raw[headerMap.get(cols.refundQty)!]) : 0,
      refundAmount: cols.refundAmount ? safeNumber(raw[headerMap.get(cols.refundAmount)!]) : 0,
      ...(cols.promotion
        ? { promotionDirect: safeNumber(raw[headerMap.get(cols.promotion)!]) }
        : {}),
    });
  }

  if (skipped) notes.push(`有 ${skipped} 行商品名为空，已跳过。`);

  return {
    rows,
    observedSkus: [...observed],
    parsedColumns: headers,
    platform,
    notes,
    source: filePath,
  };
}

/** 尽力规范化日期字符串；无法识别时保留原值（由 DQ 的日期规则兜底） */
function normalizeDateish(s: string): string {
  const m = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(s.trim());
  if (!m) return s;
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}
