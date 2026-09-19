// 找出含 % 的单元格坐标，判断该按什么语义处理
import * as NS from 'xlsx';
const XLSX = NS.default ?? NS;
const [file, sheetName] = process.argv.slice(2);
const wb = XLSX.readFile(file);
const ws = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true, header: 1 });
const h0 = rows[0] ?? [];
const h1 = rows[1] ?? [];
const hits = [];
for (let r = 0; r < rows.length; r += 1) {
  const row = rows[r] ?? [];
  for (let c = 0; c < row.length; c += 1) {
    const v = row[c];
    if (typeof v === 'string' && v.includes('%')) {
      const grp = String(h0[c] ?? '').trim();
      const metric = String(h1[c] ?? '').trim();
      hits.push(`r${r}c${c} [${grp}/${metric}] = "${v}"  (该行日期=${String(row[0] ?? '')})`);
    }
  }
}
console.log(`共 ${hits.length} 个含 % 的单元格：`);
for (const h of hits.slice(0, 30)) console.log('  ' + h);
