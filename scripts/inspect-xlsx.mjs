// 一次性探查脚本：列出工作簿结构与表头，用于校准列映射
import * as NS from 'xlsx';
const XLSX = NS.default ?? NS;

const file = process.argv[2];
const wb = XLSX.readFile(file);
console.log('工作表：', wb.SheetNames.join(' | '));
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 });
  console.log(`\n=== ${name} === 共 ${rows.length} 行`);
  console.log('表头:', JSON.stringify(rows[0] ?? []));
  console.log('第2行:', JSON.stringify(rows[1] ?? []));
  console.log('末行:', JSON.stringify(rows[rows.length - 1] ?? []));
}
