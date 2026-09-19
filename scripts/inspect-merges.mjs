// 探查合并单元格，用于确定"分组表头"的权威列范围
import * as NS from 'xlsx';
const XLSX = NS.default ?? NS;

const file = process.argv[2];
const wb = XLSX.readFile(file, { cellStyles: false });

for (const name of process.argv.slice(3)) {
  const ws = wb.Sheets[name];
  if (!ws) { console.log(`!! 无 ${name}`); continue; }
  const merges = ws['!merges'] ?? [];
  console.log(`\n########## ${name}  merges=${merges.length} ##########`);
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 });
  const row0 = rows[0] ?? [];
  const inRow0 = merges
    .filter((m) => m.s.r === 0)
    .map((m) => {
      const label = String(row0[m.s.c] ?? '').trim();
      return `c${m.s.c}..c${m.e.c} = "${label}"`;
    });
  console.log('  第0行合并:', inRow0.join(' | ') || '(无)');
  // 未合并但在第0行有值的列
  const mergedCols = new Set();
  for (const m of merges) if (m.s.r === 0) for (let c = m.s.c; c <= m.e.c; c += 1) mergedCols.add(c);
  const loose = row0
    .map((v, i) => ({ i, v: String(v ?? '').trim() }))
    .filter((x) => x.v && !mergedCols.has(x.i));
  console.log('  第0行未合并独立标签:', loose.map((x) => `c${x.i}="${x.v}"`).join(' | ') || '(无)');
  console.log('  !ref:', ws['!ref']);
}
