/**
 * 只读探查：源表里是否存在「只有总计、缺平台拆分」的经营日。
 *
 * 由来：另一条实现线的 M0/M1 交付包报告「2026-07 有 15 天只有总计、缺平台拆分，
 * 缺口 GMV 20,673.09」。本脚本用真实工作簿独立复核该结论是否成立。
 *
 * 运行：node scripts/probe-unallocated.mjs
 */

import XLSX from 'xlsx';

const wb = XLSX.readFile('data/raw/营销发展日报.xlsx');
let grand = 0;

for (const name of wb.SheetNames) {
  if (!/月汇总/.test(name)) continue;
  const m = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
  let onlyTotal = 0;
  let both = 0;
  let gap = 0;
  const samples = [];

  for (let r = 2; r < m.length; r += 1) {
    const row = m[r] || [];
    const date = row[0];
    if (date === '' || date === undefined || date === null) continue;
    const total = Number(row[1] ?? 0) || 0;
    const platSum = [2, 3, 4, 5, 6, 7].reduce((a, i) => a + (Number(row[i] ?? 0) || 0), 0);
    if (total > 0 && platSum === 0) {
      onlyTotal += 1;
      gap += total;
      if (samples.length < 4) samples.push(date + '=' + total);
    } else if (total > 0) {
      both += 1;
    }
  }

  if (onlyTotal) {
    console.log(name + ': 仅总计无平台拆分 ' + onlyTotal + ' 天，缺口 GMV ' + gap.toFixed(2) + '，样例 ' + samples.join(' '));
    grand += onlyTotal;
  } else {
    console.log(name + ': 无缺口（有总计且有拆分 ' + both + ' 天）');
  }
}

console.log(grand ? '\n合计缺口天数 ' + grand : '\n未发现「仅总计」记录');
