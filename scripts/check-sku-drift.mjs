#!/usr/bin/env node
/**
 * check-sku-drift —— SKU 主数据漂移检测（纳入 npm run gate）
 *
 * 为什么需要它：
 *   V9 → V10 迁移时主数据被人手改成 5 款占位 SKU，与真实源（7 款 + 57 行 BOM + 40 条报价）
 *   静默漂移了数周，直到人工比对才被发现，期间所有毛利/ROI 结论都建立在错的成本上。
 *   主数据一旦可以手改，就一定会漂移；所以这里把「源库 vs 主数据」做成**可执行的断言**。
 *
 * 检测维度（任一命中即 exit 1）：
 *   D1 SKU 集合漂移   —— 源库有而主数据没有 / 反之
 *   D2 规格漂移       —— 同一 SKU 的 spec 变了（如 暗戳戳 100ml → 50ml）
 *   D3 售价漂移       —— defaultPrice 变了
 *   D4 预估月销漂移   —— estMonthlyQty 变了
 *   D5 单瓶成本漂移   —— unitCost / unitCostCogs 变了（±0.01 容差）
 *   D6 BOM 结构漂移   —— 组件名或用量变了
 *   D7 口径降级       —— bomSource 从 verified 退化为 placeholder
 *   D8 生成器漂移     —— 文件不是由 sync-sku-master.mjs 生成（说明有人手改过）
 *
 * 用法：
 *   node scripts/check-sku-drift.mjs
 *   node scripts/check-sku-drift.mjs --fix-hint   # 额外打印修复命令
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = resolve(ROOT, 'data/master/sku-bom.json');
const DEFAULT_DB = resolve(homedir(), 'Desktop/09_项目文件夹/时法营销日报/营销发展日报.db');
const DB_PATH = process.env.ORIGO_SKU_DB || DEFAULT_DB;
const HINT = process.argv.includes('--fix-hint');
/** --strict：源库缺失也算失败（发布前必用；CI 没有源库，用宽松模式） */
const STRICT = process.argv.includes('--strict');

if (!existsSync(MASTER)) {
  console.error(`✗ 主数据不存在：${MASTER}`);
  console.error('  先跑 node scripts/sync-sku-master.mjs 生成。');
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  const msg = `⚠ SKU 源库不存在：${DB_PATH}\n  无法校验漂移 —— 这不是"通过"，而是"无法判断"。`;
  if (STRICT) {
    console.error(msg);
    console.error('  发布前请挂载源库，或用 ORIGO_SKU_DB 指定路径。');
    process.exit(1);
  }
  // 宽松模式（CI / 无源库环境）：明确告知跳过，绝不伪装成"校验通过"
  console.log('──────── SKU 主数据漂移检测 ────────');
  console.log(msg);
  console.log('  → 已跳过。本地与发布前请加 --strict 强制校验。');
  process.exit(0);
}

const master = JSON.parse(readFileSync(MASTER, 'utf8'));
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const srcProducts = db.prepare(`SELECT name, spec, price, est_monthly_qty, product_line FROM products`).all();
const srcBom = db.prepare(`SELECT product_name, component, qty FROM product_bom ORDER BY id`).all();
const srcQuotes = db.prepare(`SELECT supplier, component, price FROM product_quotes`).all();
db.close();

const r4 = (v) => Math.round((v + Number.EPSILON) * 10000) / 10000;

// ── 用与 sync 脚本完全相同的规则重算期望值 ──
const SAMPLE = new Set(['试香卡版本2', '试香卡2蜡纸袋', '1.5ml小样瓶+喷丝印350版费', '小样卡纸包装350g']);
const ONE_OFF = new Set(['香水备案', '香水二次备案']);

const qByComp = new Map();
for (const q of srcQuotes) {
  const list = qByComp.get(String(q.component)) ?? [];
  list.push({ supplier: String(q.supplier), price: Number(q.price) });
  qByComp.set(String(q.component), list);
}
for (const l of qByComp.values()) l.sort((a, b) => a.price - b.price);

const bomByProduct = new Map();
for (const r of srcBom) {
  const list = bomByProduct.get(String(r.product_name)) ?? [];
  list.push({ component: String(r.component), qty: Number(r.qty) });
  bomByProduct.set(String(r.product_name), list);
}

/** 期望的主数据（只算 drift 需要的字段，与 sync 脚本口径一致） */
const expected = new Map();
for (const p of srcProducts) {
  const sku = String(p.name);
  const lines = bomByProduct.get(sku) ?? [];
  let full = 0;
  let cogs = 0;
  const comps = new Map();
  for (const l of lines) {
    const cands = qByComp.get(l.component) ?? [];
    const price = cands.length ? cands[0].price : 0;
    full += price * l.qty;
    if (!SAMPLE.has(l.component) && !ONE_OFF.has(l.component)) cogs += price * l.qty;
    comps.set(l.component, l.qty);
  }
  expected.set(sku, {
    spec: String(p.spec ?? ''),
    productLine: String(p.product_line ?? ''),
    defaultPrice: Number(p.price ?? 0),
    estMonthlyQty: Number(p.est_monthly_qty ?? 0),
    unitCost: r4(full),
    unitCostCogs: r4(cogs),
    comps,
  });
}

// ── 比对 ──
const actual = new Map();
for (const i of master.items ?? []) {
  const comps = new Map();
  for (const b of i.bom ?? []) comps.set(String(b.name), Number(b.qty));
  actual.set(String(i.sku), {
    spec: String(i.spec ?? ''),
    productLine: String(i.productLine ?? ''),
    defaultPrice: Number(i.defaultPrice ?? 0),
    estMonthlyQty: Number(i.estMonthlyQty ?? 0),
    unitCost: Number(i.unitCost ?? 0),
    unitCostCogs: Number(i.unitCostCogs ?? 0),
    comps,
    bomSource: i.bomSource,
  });
}

const drift = [];
const push = (code, sku, field, from, to) =>
  drift.push({ code, sku, field, from: String(from), to: String(to) });

for (const [sku, exp] of expected) {
  const act = actual.get(sku);
  if (!act) {
    push('D1', sku, 'SKU 缺失', `源库有（${exp.spec} / ¥${exp.defaultPrice}）`, '主数据里没有');
    continue;
  }
  if (act.spec !== exp.spec) push('D2', sku, '规格', exp.spec, act.spec);
  if (Math.abs(act.defaultPrice - exp.defaultPrice) > 0.005)
    push('D3', sku, '售价', `¥${exp.defaultPrice}`, `¥${act.defaultPrice}`);
  if (act.estMonthlyQty !== exp.estMonthlyQty)
    push('D4', sku, '预估月销', exp.estMonthlyQty, act.estMonthlyQty);
  if (Math.abs(act.unitCost - exp.unitCost) > 0.0011)
    push('D5', sku, '全口径单瓶成本', `¥${exp.unitCost.toFixed(4)}`, `¥${act.unitCost.toFixed(4)}`);
  if (Math.abs(act.unitCostCogs - exp.unitCostCogs) > 0.0011)
    push('D5', sku, 'COGS 单瓶成本', `¥${exp.unitCostCogs.toFixed(4)}`, `¥${act.unitCostCogs.toFixed(4)}`);
  for (const [c, q] of exp.comps) {
    if (!act.comps.has(c)) push('D6', sku, `BOM 组件缺失：${c}`, `×${q}`, '—');
    else if (Math.abs(act.comps.get(c) - q) > 1e-9) push('D6', sku, `BOM 用量：${c}`, q, act.comps.get(c));
  }
  for (const c of act.comps.keys()) {
    if (!exp.comps.has(c)) push('D6', sku, `BOM 多余组件：${c}`, '—', '主数据独有');
  }
  if (act.bomSource === 'placeholder') push('D7', sku, 'bomSource', 'verified', 'placeholder（口径降级）');
}
for (const sku of actual.keys()) {
  if (!expected.has(sku)) push('D1', sku, 'SKU 多余', '源库已无此款', '主数据仍保留');
}

if (master.generatedBy !== 'scripts/sync-sku-master.mjs') {
  push('D8', '(文件级)', 'generatedBy', 'scripts/sync-sku-master.mjs', master.generatedBy ?? '(缺失，疑似手改)');
}

// ── 报告 ──
const CODE_NAME = {
  D1: 'SKU 集合漂移',
  D2: '规格漂移',
  D3: '售价漂移',
  D4: '预估月销漂移',
  D5: '单瓶成本漂移',
  D6: 'BOM 结构漂移',
  D7: '口径降级',
  D8: '生成器漂移',
};

console.log('──────── SKU 主数据漂移检测 ────────');
console.log(`源库      ${DB_PATH.replace(homedir(), '~')}（${expected.size} 款）`);
console.log(`主数据    data/master/sku-bom.json（${actual.size} 款，bomSource=${master.bomSource ?? '?'}）`);
console.log(`综合单瓶  ¥${master.weightedUnitCost ?? '?'}（全口径）/ ¥${master.weightedUnitCostCogs ?? '?'}（COGS）`);
console.log('');

if (!drift.length) {
  console.log('✓ 无漂移：主数据与源库完全一致。');
  process.exit(0);
}

console.log(`✗ 检测到 ${drift.length} 处漂移：`);
console.log('');
const byCode = new Map();
for (const d of drift) {
  const list = byCode.get(d.code) ?? [];
  list.push(d);
  byCode.set(d.code, list);
}
for (const code of [...byCode.keys()].sort()) {
  const list = byCode.get(code);
  console.log(`  ${code} · ${CODE_NAME[code]}（${list.length}）`);
  for (const d of list) {
    console.log(`      ${d.sku.padEnd(18)} ${d.field.padEnd(22)} 源库=${d.from}  主数据=${d.to}`);
  }
  console.log('');
}

if (HINT) {
  console.log('修复：');
  console.log('  1) 确认源库是最新版（改数据请改源库，不要直接改 JSON）');
  console.log('  2) node scripts/sync-sku-master.mjs');
  console.log('  3) npm run gate && npm run origo -- build && npm run build:web');
}

process.exit(1);
