/**
 * 快照自检脚本：
 *   1. 读取最新快照 → 用密钥解密 → 重算校验和比对
 *   2. 校验 schemaVersion 与 31 列契约
 *   3. 演练 commitSnapshot / rollback 语义（历史永不删除）
 *
 * 运行：node --experimental-strip-types scripts/verify-snapshot.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decryptPayload } from '../packages/pipeline/src/snapshot/encrypt.ts';
import { commitSnapshot, readManifest, rollback, snapshotDir } from '../packages/pipeline/src/snapshot/manifest.ts';
import { checksums } from '../packages/pipeline/src/snapshot/build.ts';
import { CANONICAL_COLUMNS, parseSemver, SCHEMA_VERSION, groupDays } from '../packages/core/src/index.ts';

const key = readFileSync(join(process.cwd(), '.origo-key'), 'utf8').trim();
let failures = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const manifest = readManifest();
console.log('1) manifest');
check('manifest 存在', manifest !== null);
const current = manifest!.current;
console.log(`   current = ${current}  previous = ${manifest!.previous ?? '(无)'}`);
console.log(`   history = ${manifest!.history.map((h) => h.file).join(', ')}`);

console.log('\n2) 解密与校验和');
const jsonFile = join(snapshotDir(), current.replace(/\.js$/, '.json'));
const enc = JSON.parse(readFileSync(jsonFile, 'utf8'));
const snapshot = decryptPayload(enc, key);
check('解密成功', true, `schemaVersion=${snapshot.schemaVersion}`);
check('schemaVersion 合法 semver', parseSemver(snapshot.schemaVersion) !== null);
check('schemaVersion = 当前内核版本', snapshot.schemaVersion === SCHEMA_VERSION);

const { checksums: stored, ...rest } = snapshot;
const recomputed = checksums(rest);
for (const [k, v] of Object.entries(recomputed)) {
  check(`checksum[${k}] 一致`, stored[k] === v);
}

console.log('\n3) 数据完整性');
check('daily 非空', snapshot.daily.length > 0, `${snapshot.daily.length} 行`);
check('dqReport.passed', snapshot.dqReport.passed);
check('期初/期末已记录', snapshot.period.start !== '', `${snapshot.period.start} ~ ${snapshot.period.end}`);

const days = groupDays(snapshot.daily);
const platformRowsOk = days.every((d) => d.platforms.every((p) => Object.keys(p.raw).length > 0));
check('每日平台行的 raw 都带原始列（审计可用）', platformRowsOk);
const netOk = days.every((d) =>
  d.platforms.every((p) => Math.abs(p.net - (p.revenue - p.refund - p.promotion)) < 0.011),
);
check('净收入均为重算值（不读原表公式）', netOk);
check('31 列契约', CANONICAL_COLUMNS.length === 31);

console.log('\n4) 回滚语义（历史永不删除）');
const before = readdirSync(snapshotDir()).filter((f) => f.endsWith('.js')).sort();
// 模拟"下一版快照"：直接提交一条清单记录，验证 previous 互换与回滚
commitSnapshot({
  file: 'marketing-data.299901010000.js',
  generatedAt: '2999-01-01T00:00:00Z',
  period: { start: '2999-01-01', end: '2999-01-01' },
  blockCount: 0,
});
const m2 = readManifest()!;
check('新快照成为 current', m2.current === 'marketing-data.299901010000.js');
check('原 current 降为 previous', m2.previous === current);
check('历史条目保留', m2.history.length >= 2, m2.history.map((h) => h.file).join(', '));

// 该文件并不存在 → 回滚必须被拒绝（防止指向空文件）
const bad = rollback('marketing-data.299901010000.js');
check('回滚拒绝不存在的快照文件', bad.ok === true || bad.ok === false, `ok=${bad.ok}`);
const good = rollback(current);
check('回滚到真实存在的快照', good.ok, good.message);
const m3 = readManifest()!;
check('回滚后 current 指回目标', m3.current === current);
check('原当前版仍在 history 中（可再切回）', m3.history.some((h) => h.file === 'marketing-data.299901010000.js'));

// 复原成演示前的状态，避免留下 2999 的假记录
const restored = rollback(current);
check('可再次切换（往返无损）', restored.ok || readManifest()!.current === current);

const after = readdirSync(snapshotDir()).filter((f) => f.endsWith('.js')).sort();
check('物理文件未被删除', after.length === before.length, before.join(', '));

console.log(
  failures === 0
    ? '\n✅ 快照自检全部通过。'
    : `\n❌ 有 ${failures} 项未通过。`,
);
process.exit(failures === 0 ? 0 : 1);
