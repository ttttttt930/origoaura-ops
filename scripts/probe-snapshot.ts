/**
 * 只读探查：解密最新快照，打印前端要消费的真实数据形状与规模。
 * 运行：node --experimental-strip-types scripts/probe-snapshot.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from '../packages/core/src/index.ts';
import { decryptPayload } from '../packages/pipeline/src/snapshot/encrypt.ts';
import { readManifest, snapshotDir } from '../packages/pipeline/src/snapshot/manifest.ts';

const key = readFileSync(join(process.cwd(), '.origo-key'), 'utf8').trim();
const manifest = readManifest();
if (!manifest) throw new Error('no manifest');
const jsonFile = join(snapshotDir(), manifest.current.replace(/\.js$/, '.json'));
const enc = JSON.parse(readFileSync(jsonFile, 'utf8'));
const s = decryptPayload(enc, key) as Snapshot;

const j = (v: unknown): string => JSON.stringify(v);

console.log('schemaVersion      ', s.schemaVersion);
console.log('generatedAt        ', s.generatedAt);
console.log('period             ', j(s.period));
console.log('pipelineVersion    ', s.pipelineVersion);
console.log('daily rows         ', s.daily.length);
console.log('skuDaily rows      ', s.skuDaily.length);
console.log('skuMaster          ', s.skuMaster.length, s.skuMaster.map((k) => k.sku).join(', '));
console.log('dqReport           ', j({ passed: s.dqReport.passed, b: s.dqReport.blockCount, w: s.dqReport.warnCount, rulesRun: s.dqReport.rulesRun }));
console.log('checksums keys     ', Object.keys(s.checksums).join(', '));
console.log('costPolicy         ', j(s.costPolicy));
console.log('taxParams keys     ', Object.keys(s.taxParams).length);

console.log('\n--- daily[0] ---');
console.log(j(s.daily[0], null, 2));

console.log('\n--- daily 平台分布 ---');
const byP = new Map<string, number>();
for (const d of s.daily) byP.set(d.platform, (byP.get(d.platform) ?? 0) + 1);
console.log(j([...byP.entries()]));

console.log('\n--- 日期范围 ---');
const dates = [...new Set(s.daily.map((d) => d.date))].sort();
console.log(dates.length, '天', dates[0], '→', dates[dates.length - 1]);

console.log('\n--- 9 月逐日营收合计 ---');
const rows = s.daily.filter((d) => d.date >= '2026-09-01' && d.date <= '2026-09-30');
const byDate = new Map<string, { rev: number; refund: number; promo: number; qty: number }>();
for (const r of rows) {
  const c = byDate.get(r.date) ?? { rev: 0, refund: 0, promo: 0, qty: 0 };
  c.rev += r.revenue; c.refund += r.refund; c.promo += r.promotion; c.qty += r.qty;
  byDate.set(r.date, c);
}
for (const [d, c] of [...byDate.entries()].sort()) {
  console.log(d, 'rev', c.rev.toFixed(2), 'refund', c.refund.toFixed(2), 'promo', c.promo.toFixed(2), 'qty', c.qty);
}
const agg = { rev: 0, refund: 0, promo: 0, qty: 0 };
for (const c of byDate.values()) { agg.rev += c.rev; agg.refund += c.refund; agg.promo += c.promo; agg.qty += c.qty; }
console.log('SUM rev', agg.rev.toFixed(2), 'refund', agg.refund.toFixed(2), 'promo', agg.promo.toFixed(2), 'qty', agg.qty);
console.log('SUM 净收入(重算)', (agg.rev - agg.refund - agg.promo).toFixed(2));

console.log('\n--- 全期按月汇总 ---');
const byM = new Map<string, { rev: number; qty: number }>();
for (const r of s.daily) {
  const m = r.date.slice(0, 7);
  const c = byM.get(m) ?? { rev: 0, qty: 0 };
  c.rev += r.revenue; c.qty += r.qty;
  byM.set(m, c);
}
for (const [m, c] of [...byM.entries()].sort()) {
  console.log(m, 'rev', c.rev.toFixed(2), 'qty', c.qty);
}

console.log('\n--- skuMaster[0].bom[0] ---');
console.log(j(s.skuMaster[0]?.bom?.[0]));
