/**
 * 只读探查：用真实快照跑一遍 5 档时间口径 + 渠道 + 预警 + DQ，确认前端要渲染的数字正确。
 * 运行：node --experimental-strip-types scripts/probe-periods.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DailyRecord, Snapshot } from '../packages/core/src/index.ts';
import {
  aggregatePeriod,
  buildAlerts,
  channelBreakdown,
  formatDqReport,
  heroCards,
  PERIOD_KINDS,
  summarizeByRule,
} from '../packages/core/src/index.ts';
import { decryptPayload } from '../packages/pipeline/src/snapshot/encrypt.ts';
import { readManifest, snapshotDir } from '../packages/pipeline/src/snapshot/manifest.ts';

const key = readFileSync(join(process.cwd(), '.origo-key'), 'utf8').trim();
const manifest = readManifest();
if (!manifest) throw new Error('no manifest');
const enc = JSON.parse(readFileSync(join(snapshotDir(), manifest.current.replace(/\.js$/, '.json')), 'utf8'));
const s = decryptPayload(enc, key) as Snapshot;
const daily = s.daily as DailyRecord[];
const TODAY = '2026-09-16';

for (const kind of PERIOD_KINDS) {
  const r = aggregatePeriod(daily, kind, TODAY, s.skuMaster);
  const m = r.metrics;
  console.log(
    `${kind.padEnd(6)} ${r.window.label}`,
    `| cal=${r.window.calendarDays} obs=${r.window.observedDays} blank=${r.window.blankDays}`,
    `| partial=${r.window.isPartialMonth} proj=${r.window.projFactor ?? '-'}`,
  );
  console.log(
    `        GMV=${m.gmv} 退款=${m.refund} 推广=${m.promotion} 销量=${m.qty} 物料=${m.materialCost} 真实净利=${m.realProfit} 回款=${m.cashback} 真实ROI=${m.realRoi} 日均=${m.dailyAvgGmv}`,
  );
  if (m.projected) console.log(`        整月预估 GMV=${m.projected.gmv} 真实净利=${m.projected.realProfit} 回款=${m.projected.cashback}`);
  console.log(`        delta=${r.delta}`);
}

const month = aggregatePeriod(daily, 'month', TODAY, s.skuMaster);
console.log('\n--- Hero 卡片 ---');
for (const c of heroCards(month)) {
  console.log(`  ${c.title.padEnd(22)} ${c.key.padEnd(11)} value=${c.value} zone=${c.zone ?? '-'} sub=${c.sub}`);
}

const ch = channelBreakdown(daily, month.window, s.skuMaster);
console.log('\n--- 渠道 ---');
console.log('HHI', ch.hhi, 'activePlatforms', ch.activePlatforms, '|', ch.concentration?.level);
for (const c of ch.channels) {
  console.log(
    `  ${c.label.padEnd(8)} rev=${c.revenue} 退款率=${c.refundRate}% 占比=${c.shareOfRevenue}% 真实ROI=${c.realRoi} active=${c.active}`,
  );
}

console.log('\n--- 预警 ---');
const alerts = buildAlerts({ period: month, channels: ch, daily, targets: {} });
for (const a of alerts) console.log(`  [${a.level}] ${a.title} — ${a.message}`);

console.log('\n--- 质量中心（DQ） ---');
console.log(`passed=${s.dqReport.passed} block=${s.dqReport.blockCount} warn=${s.dqReport.warnCount} rulesRun=${s.dqReport.rulesRun}`);
console.log(summarizeByRule(s.dqReport));
console.log(formatDqReport(s.dqReport));
