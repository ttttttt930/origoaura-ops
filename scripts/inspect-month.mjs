// 聚焦探查：按月汇总表的「两行分组表头」+ 前几行数据
import * as NS from 'xlsx';
const XLSX = NS.default ?? NS;

const file = process.argv[2];
const wb = XLSX.readFile(file);
const targets = process.argv.slice(3);

for (const name of targets) {
  const ws = wb.Sheets[name];
  if (!ws) {
    console.log(`!! 找不到工作表 ${name}`);
    continue;
  }
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 });
  console.log(`\n########## ${name}（共 ${rows.length} 行）##########`);
  const h1 = rows[0] ?? [];
  const h2 = rows[1] ?? [];
  const width = Math.max(h1.length, h2.length);
  for (let i = 0; i < width; i += 1) {
    const a = String(h1[i] ?? '').trim();
    const b = String(h2[i] ?? '').trim();
    if (!a && !b) continue;
    console.log(`  [${String(i).padStart(2)}] ${a || '·'} / ${b || '·'}`);
  }
  console.log('  --- 数据行样例 ---');
  for (let r = 2; r < Math.min(rows.length, 6); r += 1) {
    const line = (rows[r] ?? []).map((v, i) => (v === '' ? null : `${i}:${v}`)).filter(Boolean);
    console.log(`  r${r}: ${line.join('  ')}`);
  }
}
