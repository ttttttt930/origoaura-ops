/**
 * 只读裁定：直接读 Excel **原始单元格**（不经过任何规范化逻辑），
 * 判定 golden 夹具与工作簿的日期错位到底是谁的 off-by-one。
 *
 * 运行：node scripts/verify-date-align.mjs
 */

import XLSX from 'xlsx';

const wb = XLSX.readFile('data/raw/营销发展日报.xlsx');

for (const name of ['2月汇总', '7月汇总']) {
  const ws = wb.Sheets[name];
  if (!ws) continue;
  const m = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  console.log('=== ' + name + ' ===');
  console.log('  分组表头行: ' + JSON.stringify((m[0] || []).slice(0, 8)));
  console.log('  指标表头行: ' + JSON.stringify((m[1] || []).slice(0, 8)));

  // 只看前 4 个数据行的「日期列」原始值，含单元格类型
  for (let r = 2; r <= 5 && r < m.length; r += 1) {
    const raw = m[r][0];
    const cell = ws['A' + (r + 1)];
    const info = cell ? 'type=' + cell.t + (cell.v !== undefined ? ' v=' + cell.v : '') + (cell.w ? ' w=' + cell.w : '') : '(无单元格)';
    console.log('  第' + (r + 1) + '行 日期列: 值=' + JSON.stringify(raw) + '  [' + info + ']');
  }
  console.log('');
}

// 再抽查 7 月：golden 声称有 15 天缺平台拆分，这里看平台收入列是否真的全为 0
const ws7 = wb.Sheets['7月汇总'];
if (ws7) {
  const m7 = XLSX.utils.sheet_to_json(ws7, { header: 1, defval: '' });
  console.log('=== 7月汇总：逐日检查「总收入」与各平台收入 ===');
  let zeroPlatformDays = 0;
  const samples = [];
  for (let r = 2; r < m7.length; r += 1) {
    const row = m7[r] || [];
    const date = row[0];
    if (!date) continue;
    const total = Number(row[1] ?? 0) || 0;
    const plat = [2, 3, 4, 5, 6, 7].map((i) => Number(row[i] ?? 0) || 0);
    const platSum = plat.reduce((a, b) => a + b, 0);
    if (total > 0 && platSum === 0) {
      zeroPlatformDays += 1;
      if (samples.length < 5) samples.push(date + '(总计' + total + ')');
    }
  }
  console.log('  平台列全为 0 的天数: ' + zeroPlatformDays + (samples.length ? '  样例: ' + samples.join(' ') : ''));
}
