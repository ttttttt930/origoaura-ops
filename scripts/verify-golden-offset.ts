/**
 * 只读裁定：定位 golden 夹具日期错位的**确切性质**。
 *
 * 已知线索：
 *   · 2月汇总 在源表里是倒序（第3行=2/28、第4行=2/27…），且日期存为 Excel 序列号（type=n）
 *   · 7月汇总 是正序，日期存为文本（type=s）
 *   · golden[02-02] 的数值 == 本仓库解析出的 02-01 数值，疑似 +1 天偏移
 *
 * 本脚本逐月打印：源表行序 vs 实际日期 vs 收入，并与 golden 对照，
 * 以判定错位是「整体 +1 天」「倒序镜像」还是「仅部分月份受影响」。
 *
 * 运行：node --experimental-strip-types scripts/verify-golden-offset.ts
 */

import { readFileSync } from 'node:fs';
import { ingestDailyMonthly } from '../packages/pipeline/src/adapters/dailyMonthly.ts';
import { groupDays } from '../packages/core/src/index.ts';
import type { DailyRecord } from '../packages/core/src/index.ts';

const r = ingestDailyMonthly('data/raw/营销发展日报.xlsx', { profile: 'default' });
const days = groupDays(r.records);
const real = new Map<string, number>();
for (const d of days) {
  real.set(d.date, Math.round(d.platforms.reduce((a, p: DailyRecord) => a + p.revenue, 0) * 100) / 100);
}

const g = JSON.parse(
  readFileSync('packages/core/tests/fixtures/golden/rows-250d.json', 'utf8'),
) as { rows: { date: string; values: Record<string, number> }[] };
const gold = new Map<string, number>();
for (const row of g.rows) {
  gold.set(row.date, Math.round(Number(row.values['总收入'] ?? 0) * 100) / 100);
}

function shiftCheck(month: string): void {
  const dates = [...real.keys()].filter((d) => d.startsWith(month)).sort();
  let plus1 = 0;
  let exact = 0;
  let other = 0;
  for (const d of dates) {
    const rv = real.get(d)!;
    if (gold.get(d) !== undefined && Math.abs((gold.get(d) ?? 0) - rv) < 0.01) {
      exact += 1;
      continue;
    }
    // golden 的「次日」是否装着今天的数值 → 说明 golden 整体 +1 天
    const next = d.slice(0, 8) + String(Number(d.slice(8)) + 1).padStart(2, '0');
    if (gold.get(next) !== undefined && Math.abs((gold.get(next) ?? 0) - rv) < 0.01) {
      plus1 += 1;
      continue;
    }
    other += 1;
  }
  const total = exact + plus1 + other;
  const tag = exact === total ? '✅ 完全一致' : plus1 === total ? '⚠️ golden 整体 +1 天' : other === total ? '❌ 无规律' : '🔶 混合';
  console.log(
    month + ': 共 ' + total + ' 天 → 一致 ' + exact + ' / golden+1天 ' + plus1 + ' / 其他 ' + other + '   ' + tag,
  );
}

console.log('=== 逐月判定 golden 与本仓库解析的关系 ===');
for (const m of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) {
  shiftCheck(m);
}

console.log('\n=== 2 月前 6 天对照（数值口径） ===');
for (const d of ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06']) {
  console.log('  ' + d + '  本仓库=' + String(real.get(d) ?? '—').padEnd(10) + ' golden=' + String(gold.get(d) ?? '—'));
}
