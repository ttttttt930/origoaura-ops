/**
 * 从 zip 的 rows-250d.json 抽取「已验证一致」的 2026-06/07/08 三个月，
 * 落为可信回归夹具 rows-trusted-0608.json，并**独立**（不调用 @origo/core）
 * 算出期望值，供 golden-rows.test.ts 做交叉校验。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const GOLDEN_DIR = '../packages/core/tests/fixtures/golden/';
const src = JSON.parse(readFileSync(here(GOLDEN_DIR + 'rows-250d.json'), 'utf8'));

/**
 * 可信月份：逐月对账后仅 6 月、8 月 100% 一致。
 *   02–05 月：golden 日期整体 +1 天（源表 2 月为倒序 Excel 序列号，zip 解析器未处理）
 *   07 月   ：淘宝/抖音等平台列的收入为「带千分位的文本」（如 "1,291.44"），
 *             zip 解析器直接归零 → 15 天平台收入缺口 ¥20,673.09
 *             （源数据本身没问题，是解析缺陷，见 fixtures/golden/README.md）
 *   01 / 09 月：混合，不纳入
 */
const TRUSTED_MONTHS = ['2026-06', '2026-08'];
const rows = src.rows.filter((r) => TRUSTED_MONTHS.includes(r.date.slice(0, 7)));

console.log(`抽取 ${rows.length} 天（${TRUSTED_MONTHS.join('、')}）`);

// ---- 1) 自洽校验：平台列之和 == 总计列 ----
const PLAT = ['淘宝', '抖音', '拼多多', '小红书', 'tiktok'];
let mismatch = 0;
for (const r of rows) {
  const v = r.values;
  for (const [total, key] of [
    ['总收入', '收入'],
    ['总退款', '退款'],
    ['总推广支出', '推广支出'],
    ['总销量', '销量'],
  ]) {
    const sum = round2(PLAT.reduce((a, p) => a + (v[`${p}${key}`] ?? 0), 0));
    if (Math.abs(sum - (v[total] ?? 0)) > 0.011) {
      if (mismatch < 6) console.log(`  ⚠️ ${r.date} ${total}: 平台合计 ${sum} vs 总计 ${v[total]}`);
      mismatch++;
    }
  }
}
console.log(`平台合计 vs 总计：不一致 ${mismatch} 处`);

// ---- 2) 独立计算 2026-08 整月期望值 ----
const aug = rows.filter((r) => r.date.startsWith('2026-08'));
const sum = (arr, k) => round2(arr.reduce((a, r) => a + (r.values[k] ?? 0), 0));
const active = aug.filter(
  (r) =>
    r.values['总收入'] !== 0 ||
    r.values['总退款'] !== 0 ||
    r.values['总推广支出'] !== 0 ||
    r.values['总销量'] !== 0,
);

const exp = {
  days: aug.length,
  activeDays: active.length,
  gmv: sum(aug, '总收入'),
  refund: sum(aug, '总退款'),
  promotion: sum(aug, '总推广支出'),
  qty: sum(aug, '总销量'),
};
exp.dailyAvgGmv = round2(exp.gmv / active.length);
exp.refundRate = round2((exp.refund / exp.gmv) * 100);
exp.promoRate = round2((exp.promotion / exp.gmv) * 100);
exp.aov = round2(exp.gmv / exp.qty);
exp.cashback = round2(exp.gmv - exp.promotion - exp.refund);

console.log('\n=== 2026-08 独立期望值 ===');
console.log(JSON.stringify(exp, null, 2));

// ---- 3) 独立计算 2026-06/07 期望值（供多用例） ----
for (const ym of TRUSTED_MONTHS) {
  const m = rows.filter((r) => r.date.startsWith(ym));
  const act = m.filter(
    (r) =>
      r.values['总收入'] !== 0 ||
      r.values['总退款'] !== 0 ||
      r.values['总推广支出'] !== 0 ||
      r.values['总销量'] !== 0,
  );
  console.log(
    `${ym}: days=${m.length} active=${act.length} gmv=${sum(m, '总收入')} refund=${sum(m, '总退款')} promo=${sum(m, '总推广支出')} qty=${sum(m, '总销量')} dailyAvg=${round2(sum(m, '总收入') / act.length)}`,
  );
}

// ---- 4) 落夹具 ----
writeFileSync(
  here(GOLDEN_DIR + 'rows-trusted-0608.json'),
  JSON.stringify({ columns: src.columns, rows }, null, 0) + '\n',
);
console.log('\n已写入 rows-trusted-0608.json');

function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
