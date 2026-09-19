// 深挖单个工作表：表头分组 + 指定数据行
import * as NS from 'xlsx';
const XLSX = NS.default ?? NS;

const [file, sheetName, ...dates] = process.argv.slice(2);
const wb = XLSX.readFile(file);
const ws = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true, header: 1 });

const h0 = rows[0] ?? [];
const h1 = rows[1] ?? [];
console.log(`### ${sheetName}  行数=${rows.length}  ref=${ws['!ref']}`);
console.log('合并:', (ws['!merges'] ?? []).filter((m) => m.s.r === 0).map((m) => `c${m.s.c}-c${m.e.c}:"${String(h0[m.s.c] ?? '').trim()}"`).join(' | '));
const width = Math.max(h0.length, h1.length);
for (let c = 0; c < width; c += 1) {
  const a = String(h0[c] ?? '').trim();
  const b = String(h1[c] ?? '').trim();
  if (!a && !b) continue;
  console.log(`  c${String(c).padStart(2)}  grp="${a}"  metric="${b}"`);
}
console.log('--- 数据行 ---');
for (const want of dates) {
  const idx = rows.findIndex((r) => String(r?.[0] ?? '').startsWith(want));
  if (idx < 0) { console.log(`  ${want}: 未找到`); continue; }
  const line = (rows[idx] ?? []).map((v, i) => (v === '' ? null : `${i}:${v}`)).filter(Boolean);
  console.log(`  r${idx} ${want}: ${line.join('  ')}`);
}
