/**
 * 只读对账：把外部交付包的 golden 夹具 `rows-250d.json` 与**真实工作簿**逐日比对。
 *
 * 为什么不直接采信：该包由另一条实现线产出，其 README 声称「与 rows.json 权威总计列
 * 逐日勾稽，差额为 0」，但它同时报告了「7 月 15 天缺平台拆分」—— 该结论在本工作簿里
 * 未能复现。可信度必须由本仓库的真实数据独立裁定（跨会话交付物核验三路）。
 *
 * 运行：node --experimental-strip-types scripts/verify-golden-rows.ts
 */

import { readFileSync } from 'node:fs';
import { ingestDailyMonthly } from '../packages/pipeline/src/adapters/dailyMonthly.ts';
import { groupDays } from '../packages/core/src/index.ts';

const SRC = 'data/raw/营销发展日报.xlsx';
const GOLDEN = process.argv[2] ?? 'packages/core/tests/fixtures/golden/rows-250d.json';

// ---- 1) 真实工作簿 → 平台行 ----
const r = ingestDailyMonthly(SRC, { profile: 'default' });
console.log('工作簿解析：' + r.records.length + ' 条平台行 / ' + r.sheets.length + ' 个月表（' + r.sheets.join('、') + '）');

const days = groupDays(r.records);
const real = new Map();
for (const d of days) {
  let revenue = 0;
  const platformCount = d.platforms.length;
  for (const p of d.platforms) revenue += p.revenue;
  real.set(d.date, { revenue: Math.round(revenue * 100) / 100, platformCount, declared: d.declared?.revenue ?? null });
}

// ---- 2) golden 夹具 ----
const g = JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
  rows: { date: string; values: Record<string, number> }[];
};
const gold = new Map();
for (const row of g.rows) {
  gold.set(row.date, {
    total: Number(row.values['总收入'] ?? 0),
    platSum: ['淘宝', '抖音', '拼多多', '小红书', 'tiktok'].reduce(
      (a, p) => a + Number(row.values[p + '收入'] ?? 0),
      0,
    ),
  });
}

console.log('Golden 夹具：' + gold.size + ' 天');

// ---- 3) 逐日比对（只比两者都有的日期）----
const shared = [...gold.keys()].filter((d) => real.has(d)).sort();
let mismatch = 0;
let maxDiff = 0;
const diffSamples: string[] = [];
let goldSum = 0;
let realSum = 0;

for (const d of shared) {
  const gv = gold.get(d)!;
  const rv = real.get(d)!;
  const goldRev = gv.total > 0 ? gv.total : gv.platSum;
  const diff = Math.round((goldRev - rv.revenue) * 100) / 100;
  goldSum += goldRev;
  realSum += rv.revenue;
  if (Math.abs(diff) > 0.01) {
    mismatch += 1;
    maxDiff = Math.max(maxDiff, Math.abs(diff));
    if (diffSamples.length < 8) diffSamples.push(d + ' golden=' + goldRev.toFixed(2) + ' 工作簿=' + rv.revenue.toFixed(2));
  }
}

console.log('\n可比日期 ' + shared.length + ' 天');
console.log('  golden 合计 GMV   ' + goldSum.toFixed(2));
console.log('  工作簿 合计 GMV   ' + realSum.toFixed(2));
console.log('  差额              ' + (goldSum - realSum).toFixed(2));
console.log('  不一致天数        ' + mismatch + (mismatch ? '（最大单日差 ' + maxDiff.toFixed(2) + '）' : ''));
if (diffSamples.length) {
  console.log('  样例：');
  for (const s of diffSamples) console.log('    ' + s);
}

const onlyGolden = [...gold.keys()].filter((d) => !real.has(d)).sort();
const onlyReal = [...real.keys()].filter((d) => !gold.has(d)).sort();
console.log('\n仅 golden 有：' + onlyGolden.length + ' 天' + (onlyGolden.length ? '（' + onlyGolden[0] + ' ~ ' + onlyGolden[onlyGolden.length - 1] + '）' : ''));
console.log('仅工作簿有：' + onlyReal.length + ' 天' + (onlyReal.length ? '（' + onlyReal[0] + ' ~ ' + onlyReal[onlyReal.length - 1] + '）' : ''));

console.log(
  '\n结论：' +
    (mismatch === 0 && Math.abs(goldSum - realSum) < 0.01
      ? '✅ golden 与真实工作簿零偏差，可作为回归基准'
      : '⚠️ golden 与真实工作簿存在偏差，采信前需人工裁定差异来源'),
);
