#!/usr/bin/env node
/**
 * sync-sku-master —— SKU 主数据的**唯一生成器**
 *
 * 背景（数据漂移事故）：
 *   V9 → V10 迁移时，data/master/sku-bom.json 被人手改成 5 款 SKU + 按占比拆分的
 *   占位 BOM，而真实源（营销发展日报.db）一直是 7 款 SKU + 57 行真实 BOM + 40 条供应商报价。
 *   结果：SKU 数 7→5、暗戳戳 100ml→50ml（成本却仍沿用 100ml 的 23.08）、
 *   综合单瓶物料成本 14.59→16.79（+15%），而文件头还写着 bomSource:"placeholder"。
 *
 * 根治方式：**主数据不再允许手改**，只能由本脚本从源库导出。
 *   源库路径：环境变量 ORIGO_SKU_DB，缺省 ~/Desktop/09_项目文件夹/时法营销日报/营销发展日报.db
 *   产物：data/master/sku-bom.json   （7 款 SKU + 逐组件 BOM，bomSource:"verified"）
 *         data/master/sku-quotes.json（40 条供应商报价，供逐组件核价追溯）
 *
 * 取价策略 quotePolicy：
 *   'min'        同组件多供应商取**最低报价**（乐观口径，默认；与 V9 历史口径一致）
 *   'preferred'  取 note 中明确指定的供应商报价（保守口径，贴近实际下单）
 * 两种策略下的每个候选报价都会**完整保留**在 bom[].quotes 里，不做隐藏假设（C7）。
 *
 * 用法：
 *   node scripts/sync-sku-master.mjs                 # 正常同步
 *   node scripts/sync-sku-master.mjs --dry           # 只打印 diff，不写盘
 *   node scripts/sync-sku-master.mjs --policy=preferred
 */

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MASTER_DIR = resolve(ROOT, 'data/master');

const DEFAULT_DB = resolve(
  homedir(),
  'Desktop/09_项目文件夹/时法营销日报/营销发展日报.db',
);

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const policyArg = argv.find((a) => a.startsWith('--policy='));
const QUOTE_POLICY = policyArg ? policyArg.split('=')[1] : 'min';
const DB_PATH = process.env.ORIGO_SKU_DB || DEFAULT_DB;

if (!['min', 'preferred'].includes(QUOTE_POLICY)) {
  console.error(`✗ 未知取价策略：${QUOTE_POLICY}（可选 min | preferred）`);
  process.exit(2);
}
if (!existsSync(DB_PATH)) {
  console.error(`✗ 找不到 SKU 源库：${DB_PATH}`);
  console.error('  可用 ORIGO_SKU_DB 环境变量指定路径。');
  process.exit(2);
}

/** 试香/小样类组件：不计入 COGS（与 V9 历史口径一致） */
const SAMPLE_COMPONENTS = new Set(['试香卡版本2', '试香卡2蜡纸袋', '1.5ml小样瓶+喷丝印350版费', '小样卡纸包装350g']);

/** 备案类一次性费用：不是单瓶物料，明确排除 */
const ONE_OFF_COMPONENTS = new Set(['香水备案', '香水二次备案']);

const round4 = (v) => Math.round((v + Number.EPSILON) * 10000) / 10000;
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

// ───────────────────────────────────────── 读取源库 ─────────────────────────────────────────

const db = new DatabaseSync(DB_PATH, { readOnly: true });

const products = db
  .prepare(
    `SELECT name, spec, launch_date, position, price, est_monthly_qty, product_line, updated_at
       FROM products ORDER BY rowid`,
  )
  .all();

const bomRows = db
  .prepare(`SELECT product_name, component, qty, note FROM product_bom ORDER BY id`)
  .all();

const quoteRows = db
  .prepare(
    `SELECT supplier, category, component, component_type, material, spec, price, lead_days, moq, note, updated_at
       FROM product_quotes ORDER BY id`,
  )
  .all();

db.close();

if (!products.length) {
  console.error('✗ 源库 products 表为空，拒绝生成主数据（不做空文件覆盖）。');
  process.exit(2);
}

// ───────────────────────────────────── 报价索引与取价 ─────────────────────────────────────

/** component -> 报价数组（按 price 升序，便于 min 策略稳定取值） */
const quotesByComponent = new Map();
for (const q of quoteRows) {
  const key = String(q.component);
  const list = quotesByComponent.get(key) ?? [];
  list.push({
    supplier: String(q.supplier),
    price: Number(q.price),
    spec: q.spec == null ? null : String(q.spec),
    componentType: q.component_type == null ? null : String(q.component_type),
    moq: q.moq == null ? null : Number(q.moq),
    leadDays: q.lead_days == null ? null : Number(q.lead_days),
  });
  quotesByComponent.set(key, list);
}
for (const list of quotesByComponent.values()) {
  list.sort((a, b) => a.price - b.price || a.supplier.localeCompare(b.supplier));
}

/**
 * 从 BOM 行的 note 里解析出"指定供应商"，例如：
 *   '葵花 ¥1.3 / 润园 ¥1.1'           → 第一个出现的供应商：葵花
 *   '润园 ¥3.8'                        → 润园
 *   '葵花 ¥0.0445'                     → 葵花
 *   '墨艺 ¥1.25 (两瓶一袋)'            → 墨艺
 * 解析不出则返回 null（回落到 min 策略）。
 */
function preferredSupplier(note, candidates) {
  if (!note) return null;
  for (const s of candidates) {
    if (note.includes(s)) return s;
  }
  return null;
}

// ───────────────────────────────────────── 组装 SKU ─────────────────────────────────────────

const bomByProduct = new Map();
for (const r of bomRows) {
  const key = String(r.product_name);
  const list = bomByProduct.get(key) ?? [];
  list.push({ component: String(r.component), qty: Number(r.qty), note: r.note == null ? null : String(r.note) });
  bomByProduct.set(key, list);
}

const warnings = [];
const items = [];
/** 加权口径累加器：保留未舍入值，最后只 round 一次 */
let sumFull = 0;
let sumCogs = 0;

for (const p of products) {
  const sku = String(p.name);
  const lines = bomByProduct.get(sku) ?? [];
  if (!lines.length) {
    warnings.push(`SKU「${sku}」在 product_bom 中没有 BOM 行，unitCost 将为 0 并标记 unverified。`);
  }

  const bom = [];
  let fullCost = 0; // 全口径物料成本（含试香卡）
  let cogsCost = 0; // COGS 口径（不含试香卡/小样/备案）
  // 加权口径必须用**未舍入**的逐 SKU 成本累加：先 round 单瓶再加权会产生二次舍入偏差
  // （实测：先舍入得 14.58，正确值为 14.59）。

  for (const line of lines) {
    const candidates = quotesByComponent.get(line.component) ?? [];
    if (!candidates.length) {
      warnings.push(`组件「${line.component}」（${sku}）在 product_quotes 中无报价，按 0 计入并标记 unverified。`);
      bom.push({
        name: line.component,
        qty: line.qty,
        unitPrice: 0,
        supplier: null,
        quotes: [],
        isSample: SAMPLE_COMPONENTS.has(line.component),
        isOneOff: ONE_OFF_COMPONENTS.has(line.component),
        priced: false,
      });
      continue;
    }

    let picked;
    if (QUOTE_POLICY === 'preferred') {
      const want = preferredSupplier(line.note, candidates.map((c) => c.supplier));
      picked = want ? candidates.find((c) => c.supplier === want) : candidates[0];
    } else {
      picked = candidates[0];
    }

    const isSample = SAMPLE_COMPONENTS.has(line.component);
    const isOneOff = ONE_OFF_COMPONENTS.has(line.component);
    const amount = picked.price * line.qty;
    fullCost += amount;
    if (!isSample && !isOneOff) cogsCost += amount;

    bom.push({
      name: line.component,
      qty: line.qty,
      unitPrice: round4(picked.price),
      supplier: picked.supplier,
      quotes: candidates.map((c) => ({ supplier: c.supplier, price: round4(c.price), spec: c.spec, moq: c.moq, leadDays: c.leadDays })),
      isSample,
      isOneOff,
      priced: true,
    });
  }

  items.push({
    sku,
    spec: String(p.spec ?? ''),
    productLine: String(p.product_line ?? ''),
    position: String(p.position ?? ''),
    launchDate: String(p.launch_date ?? ''),
    unitCostRaw: fullCost,
    unitCostCogsRaw: cogsCost,
    // 存 4 位小数（BOM 单价本身就是 0.0445 这种四位精度，求和是精确值）。
    // 刻意**不在这一层舍到 2 位**：加权时会把 14.59 压成 14.58（二次舍入偏差）。
    // 展示由 UI 格式化到 2 位，计算用精确值。
    unitCost: round4(fullCost),
    unitCostCogs: round4(cogsCost),
    defaultPrice: Number(p.price ?? 0),
    status: 'active',
    estMonthlyQty: Number(p.est_monthly_qty ?? 0),
    costBasis: 'supplier-quote-2026-09',
    quotePolicy: QUOTE_POLICY,
    bomSource: bom.every((b) => b.priced) ? 'verified' : 'placeholder',
    bom,
  });
}

// ──────────────────────────────────── 综合单瓶成本（加权） ────────────────────────────────────

const totalQty = items.reduce((a, i) => a + i.estMonthlyQty, 0);
// 用未舍入值加权，最后统一 round 一次（避免二次舍入把 14.59 压成 14.58）
for (const i of items) {
  sumFull += i.unitCostRaw * i.estMonthlyQty;
  sumCogs += i.unitCostCogsRaw * i.estMonthlyQty;
}
const weightedFull = totalQty > 0 ? round2(sumFull / totalQty) : 0;
const weightedCogs = totalQty > 0 ? round2(sumCogs / totalQty) : 0;
// 中间量不进产物文件
for (const i of items) {
  delete i.unitCostRaw;
  delete i.unitCostCogsRaw;
}

const skuBom = {
  _readme:
    'SKU 主数据 —— 由 scripts/sync-sku-master.mjs 从 营销发展日报.db（products / product_bom / product_quotes）自动导出，**禁止手改**。' +
    'unitCost = 全口径单瓶物料成本（含试香卡）；unitCostCogs = COGS 口径（不含试香卡/小样/一次性备案）。' +
    '每个 BOM 行保留全部候选供应商报价（bom[].quotes），取价策略见 quotePolicy。' +
    '改数据请改源库后重跑 `node scripts/sync-sku-master.mjs`，并用 `node scripts/check-sku-drift.mjs` 验证。',
  generatedBy: 'scripts/sync-sku-master.mjs',
  source: {
    db: DB_PATH.replace(homedir(), '~'),
    tables: ['products', 'product_bom', 'product_quotes'],
    sourceUpdatedAt: products.reduce((max, p) => (String(p.updated_at ?? '') > max ? String(p.updated_at ?? '') : max), ''),
  },
  costBasis: 'supplier-quote-2026-09',
  bomSource: items.every((i) => i.bomSource === 'verified') ? 'verified' : 'placeholder',
  quotePolicy: QUOTE_POLICY,
  weightedUnitCost: weightedFull,
  weightedUnitCostCogs: weightedCogs,
  totalEstMonthlyQty: totalQty,
  sampleComponents: [...SAMPLE_COMPONENTS],
  items,
};

const quotesFile = {
  _readme: '供应商报价快照 —— 由 scripts/sync-sku-master.mjs 从 product_quotes 表导出，供逐组件核价追溯。',
  generatedBy: 'scripts/sync-sku-master.mjs',
  source: skuBom.source,
  count: quoteRows.length,
  quotes: quoteRows.map((q) => ({
    supplier: String(q.supplier),
    category: q.category == null ? null : String(q.category),
    component: String(q.component),
    componentType: q.component_type == null ? null : String(q.component_type),
    material: q.material == null ? null : String(q.material),
    spec: q.spec == null ? null : String(q.spec),
    price: Number(q.price),
    leadDays: q.lead_days == null ? null : Number(q.lead_days),
    moq: q.moq == null ? null : Number(q.moq),
    note: q.note == null ? null : String(q.note),
  })),
};

// ──────────────────────────────────────── 写盘 / 报告 ────────────────────────────────────────

console.log('──────── SKU 主数据同步 ────────');
console.log(`源库      ${skuBom.source.db}`);
console.log(`取价策略  ${QUOTE_POLICY}`);
console.log(`SKU 数    ${items.length}`);
console.log(`BOM 行数  ${bomRows.length}   报价条数 ${quoteRows.length}`);
console.log(`预估月销  ${totalQty} 瓶`);
console.log(`综合单瓶  ¥${weightedFull.toFixed(2)}（全口径）/ ¥${weightedCogs.toFixed(2)}（COGS）`);
console.log('');
console.log('   SKU              规格    售价   全口径   COGS   月销   毛利');
for (const i of items) {
  const gm = i.defaultPrice > 0 ? ((i.defaultPrice - i.unitCostCogs) / i.defaultPrice) * 100 : 0;
  console.log(
    `   ${i.sku.padEnd(16)} ${i.spec.padEnd(6)} ${String(i.defaultPrice).padStart(5)} ` +
      `${i.unitCost.toFixed(2).padStart(6)} ${i.unitCostCogs.toFixed(2).padStart(6)} ` +
      `${String(i.estMonthlyQty).padStart(5)}  ${gm.toFixed(1).padStart(5)}%`,
  );
}
if (warnings.length) {
  console.log('');
  console.log('⚠ 告警：');
  for (const w of warnings) console.log(`   ${w}`);
}

if (DRY) {
  console.log('');
  console.log('--dry 模式，未写盘。');
  process.exit(0);
}

mkdirSync(MASTER_DIR, { recursive: true });
writeFileSync(resolve(MASTER_DIR, 'sku-bom.json'), JSON.stringify(skuBom, null, 2) + '\n', 'utf8');
writeFileSync(resolve(MASTER_DIR, 'sku-quotes.json'), JSON.stringify(quotesFile, null, 2) + '\n', 'utf8');
console.log('');
console.log('✓ 已写入 data/master/sku-bom.json');
console.log('✓ 已写入 data/master/sku-quotes.json');

// ---- 脱敏模板（要入库，供新环境起步）----
// 保留结构、SKU 名、规格、售价与月销；供应商名匿名化、所有单价归零。
// 与真实文件同批生成，避免模板跟不上结构变化而腐化。
const supplierSeq = new Map();
const anon = (name) => {
  if (!name) return null;
  if (!supplierSeq.has(name)) supplierSeq.set(name, `供应商${String.fromCharCode(65 + supplierSeq.size)}`);
  return supplierSeq.get(name);
};

const example = {
  _readme:
    '【脱敏模板】真实的 sku-bom.json 含供应商名称与逐组件核价，属商业敏感数据，不入公开仓。' +
    '新环境请 `cp sku-bom.example.json sku-bom.json` 后填入真实值；' +
    '若本机挂得上源库，直接跑 `npm run sku:sync` 更省事。' +
    '本模板所有单价为 0，未填值前跑管道会得到全 0 物料成本（不会误报，但也不该拿去做决策）。' +
    `由 scripts/sync-sku-master.mjs 自动生成，结构与真实主数据同步（${items.length} 款 SKU）。`,
  costBasis: 'example',
  bomSource: 'placeholder',
  weightedUnitCost: 0,
  weightedUnitCostCogs: 0,
  totalEstMonthlyQty: totalQty,
  quotePolicy: QUOTE_POLICY,
  items: items.map((i) => ({
    sku: i.sku,
    spec: i.spec,
    productLine: i.productLine,
    position: i.position,
    launchDate: i.launchDate,
    unitCost: 0,
    unitCostCogs: 0,
    defaultPrice: i.defaultPrice,
    status: 'active',
    estMonthlyQty: i.estMonthlyQty,
    costBasis: 'example',
    bomSource: 'placeholder',
    bom: i.bom.map((b) => ({
      name: b.name,
      qty: b.qty,
      unitPrice: 0,
      supplier: anon(b.supplier),
      isSample: b.isSample ? true : undefined,
      isOneOff: b.isOneOff ? true : undefined,
    })),
  })),
};

writeFileSync(resolve(MASTER_DIR, 'sku-bom.example.json'), JSON.stringify(example, null, 2) + '\n', 'utf8');
console.log('✓ 已写入 data/master/sku-bom.example.json（脱敏模板，可入库）');
console.log('  下一步：node scripts/check-sku-drift.mjs 验证无漂移，然后 npm run gate && npm run origo -- build');
