#!/usr/bin/env node
/**
 * L4 · cli —— 工程命令行（唯一的人工入口）
 *
 *   origo ingest <文件...>   读原始 Excel → 规范化 → data/canonical/canonical.json
 *   origo validate           对 canonical 跑 DQ 闸门（不写快照），有 block 则退出码 1
 *   origo build              校验通过后产出加密快照 + 更新 manifest（有 block 则拒绝产出）
 *   origo rollback [--to f]  把生效快照指回上一版（不删任何历史）
 *   origo history            列出全部历史快照
 *   origo doctor             环境与主数据自检
 *
 * 设计原则：所有"算"的部分都在 @origo/core，本文件只负责读文件、写文件、打印。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_RULE_IDS,
  CANONICAL_COLUMNS,
  formatDqReport,
  SCHEMA_VERSION,
  summarizeByRule,
  type DailyRecord,
  type SkuDaily,
  type Targets,
} from '@origo/core';
import { ingestDaily } from './adapters/excelDaily.ts';
import { detectGroupedLayout, ingestDailyMonthly } from './adapters/dailyMonthly.ts';
import { inferPlatform, ingestPlatformSku } from './adapters/platformSku.ts';
import { XLSX } from './adapters/xlsx.ts';
import {
  loadAcknowledged,
  loadCostPolicy,
  loadInventory,
  loadSkuMaster,
  loadTargets,
  loadTaxParams,
} from './config/loadMaster.ts';
import { PATHS, masterPath } from './config/paths.ts';
import { resolvePassword, passwordWarnings } from './config/key.ts';
import {
  readCanonical,
  writeCanonical,
  type CanonicalSet,
  type CanonicalSource,
} from './store/canonical.ts';
import { DqBlockedError, buildSnapshot, validate, type BuildInput } from './snapshot/build.ts';
import { encryptSnapshot } from './snapshot/encrypt.ts';
import { commitSnapshot, listSnapshots, readManifest, rollback } from './snapshot/manifest.ts';
import { publishTo, writeSnapshot } from './snapshot/publish.ts';

/** 便于测试与 doctor 自检：解密当前快照 */
export { decryptPayload } from './snapshot/encrypt.ts';

/* ------------------------------------------------------------------ *
 * 极简参数解析（不引第三方 CLI 依赖）
 * ------------------------------------------------------------------ */
interface Args {
  _: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next;
        i += 1;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const C = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function printNotes(notes: readonly string[]): void {
  for (const n of notes) console.log(C.yellow(`  ⚠ ${n}`));
}

/* ------------------------------------------------------------------ *
 * ingest
 * ------------------------------------------------------------------ */

/** 日报文件类型：分组月度布局 / 扁平 31 列布局 / 平台商品明细 */
type FileKind = 'monthly' | 'flat' | 'sku';

/**
 * 判断文件类型。优先用布局特征而不是文件名 —— 文件名随时会被人改。
 *   分组月度布局：存在「N月汇总」且指标行含「当日收入」
 *   扁平布局：表头里直接出现「总收入」或「总推广支出」
 */
function sniffKind(path: string): FileKind {
  try {
    if (detectGroupedLayout(path)) return 'monthly';
    const wb = XLSX.readFile(path, { bookSheets: true });
    const name = wb.SheetNames[0];
    if (!name) return 'sku';
    const ws = XLSX.readFile(path).Sheets[name];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws!, { defval: '' });
    const headers = Object.keys(rows[0] ?? {});
    if (headers.some((h) => h.includes('总收入') || h.includes('总推广支出'))) return 'flat';
    return 'sku';
  } catch {
    return 'sku';
  }
}

function cmdIngest(args: Args): number {
  const files = args._.slice(1);
  if (!files.length) {
    console.error(C.red('用法：origo ingest <文件...> [--kind auto|monthly|flat|sku] [--profile default] [--platform tiktok]'));
    return 2;
  }
  const kindFlag = (args.flags.kind as string) ?? 'auto';
  const profile = (args.flags.profile as string) ?? 'default';
  const platformFlag = args.flags.platform as string | undefined;
  const generatedAt = nowIso();

  const daily: DailyRecord[] = [];
  const skuDaily: SkuDaily[] = [];
  const sources: CanonicalSource[] = [];
  const notes: string[] = [];
  let parsedColumns: string[] = [];
  let declaredColumns: string[] = [];
  let derivedColumns: string[] = [];
  const allDates: string[] = [];
  const observedSkus = new Set<string>();
  const cellIssues: CanonicalSet['cellIssues'] = [];

  for (const f of files) {
    if (!existsSync(f)) {
      console.error(C.red(`文件不存在：${f}`));
      return 2;
    }
    const kind: FileKind = kindFlag === 'auto' ? sniffKind(f) : (kindFlag as FileKind);
    const kindLabel = { monthly: '月度汇总（分组表头）', flat: '扁平日报', sku: '平台商品明细' }[kind];
    console.log(C.dim(`读取 ${basename(f)} → ${kindLabel}`));

    if (kind === 'monthly') {
      const sheetFilter = args.flags.sheets
        ? String(args.flags.sheets)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const r = ingestDailyMonthly(f, { profile, ...(sheetFilter ? { sheets: sheetFilter } : {}) });
      daily.push(...r.records);
      parsedColumns = r.parsedColumns;
      declaredColumns = r.declaredColumns;
      derivedColumns = r.derivedColumns;
      allDates.push(...r.allDates);
      notes.push(...r.notes);
      cellIssues.push(...r.cellIssues);
      console.log(
        `  ${r.rowCount} 个源行 → ${r.records.length} 条平台行 · ` +
          `月份表 ${r.sheets.length} 个（${r.sheets.join('、')}）`,
      );
      console.log(
        C.dim(
          `  各平台出现的工作表数：` +
            Object.entries(r.platformSheetCount)
              .map(([k, v]) => `${k}×${v}`)
              .join(' '),
        ),
      );
    } else if (kind === 'flat') {
      const r = ingestDaily(f, { profile, ...(args.flags.sheet ? { sheet: args.flags.sheet as string } : {}) });
      daily.push(...r.records);
      parsedColumns = r.parsedColumns;
      declaredColumns = r.declaredColumns;
      allDates.push(...r.allDates);
      notes.push(...r.notes);
      console.log(`  ${r.records.length} 条平台行 / ${r.rowCount} 个源行`);
    } else {
      const r = ingestPlatformSku(f, {
        ...(platformFlag ? { platform: platformFlag as SkuDaily['platform'] } : {}),
        ...(args.flags.sheet ? { sheet: args.flags.sheet as string } : {}),
      });
      skuDaily.push(...r.rows);
      for (const s of r.observedSkus) observedSkus.add(s);
      notes.push(...r.notes);
      console.log(`  ${r.rows.length} 条 SKU×日（平台：${r.platform}）`);
    }

    sources.push({
      file: basename(f),
      mtime: statSync(f).mtime.toISOString(),
      sha256: sha256File(f),
    });
  }

  const set: CanonicalSet = {
    generatedAt,
    sources,
    daily,
    skuDaily,
    parsedColumns,
    declaredColumns,
    derivedColumns,
    allDates,
    observedSkus: [...observedSkus],
    cellIssues,
    notes,
  };
  const path = writeCanonical(set);

  const dates = daily.map((d) => d.date).sort();
  console.log(C.green(`\n✅ 规范化完成 → ${path}`));
  console.log(
    `   日报 ${daily.length} 行 · SKU×日 ${skuDaily.length} 行 · 来源文件 ${sources.length} 个` +
      (dates.length ? ` · 日期 ${dates[0]} ~ ${dates[dates.length - 1]}` : ''),
  );
  printNotes(notes);
  console.log(C.dim('\n下一步：origo validate 检查数据质量。'));
  return 0;
}

/* ------------------------------------------------------------------ *
 * validate / build 共用
 * ------------------------------------------------------------------ */
function loadBuildInput(): { input: BuildInput; notes: string[]; fatal: string[] } {
  const canonical = readCanonical();
  if (!canonical) {
    return {
      input: null as unknown as BuildInput,
      notes: [],
      fatal: [`找不到 ${join(PATHS.canonical, 'canonical.json')}，请先运行 origo ingest。`],
    };
  }
  const sku = loadSkuMaster();
  const policy = loadCostPolicy();
  const tax = loadTaxParams();
  const ack = loadAcknowledged();
  const inv = loadInventory();
  const tg = loadTargets();

  const notes = [
    ...sku.notes,
    ...policy.notes,
    ...tax.notes,
    ...ack.notes,
    ...inv.notes,
    ...canonical.notes,
  ];
  const fatal: string[] = [];
  if (!tax.value) fatal.push('缺少 tax-rates.json：税务页需要明确的政策参数，拒绝用猜测税率计算（ADR-09）。');

  return {
    input: {
      canonical,
      skuMaster: sku.value,
      costPolicy: policy.value,
      taxParams: tax.value as NonNullable<typeof tax.value>,
      acknowledged: ack.value,
      market: (process.env.ORIGO_MARKET as 'cn' | 'overseas') ?? 'cn',
      ...(inv.value.length ? { inventory: inv.value } : {}),
      ...(tg.value ? { targets: toTargets(tg.value) } : {}),
    },
    notes,
    fatal,
  };
}

/**
 * targets.json 是"平铺的 number|null"，转成内核的 Targets 形状。
 * null 必须原样保留 —— 它表示"未设置目标"，转成 0 会算出假的 0% 达成率。
 */
function toTargets(raw: Record<string, number | null>): Partial<Targets> {
  const pick = (k: string): number | undefined => {
    const v = raw[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const out: Partial<Targets> = {};
  const monthlyRevenue = pick('monthlyRevenue');
  const monthlyProfit = pick('monthlyProfit');
  const minRealRoi = pick('minRealRoi');
  const maxRefundRate = pick('maxRefundRate');
  const maxPromoRate = pick('maxPromoRate');
  if (monthlyRevenue !== undefined) out.monthlyRevenue = monthlyRevenue;
  if (monthlyProfit !== undefined) out.monthlyProfit = monthlyProfit;
  if (minRealRoi !== undefined) out.minRealRoi = minRealRoi;
  if (maxRefundRate !== undefined) out.maxRefundRate = maxRefundRate;
  if (maxPromoRate !== undefined) out.maxPromoRate = maxPromoRate;
  return out;
}

function cmdValidate(_args: Args): number {
  const { input, notes, fatal } = loadBuildInput();
  if (fatal.length) {
    for (const f of fatal) console.error(C.red(`✖ ${f}`));
    return 2;
  }
  const report = validate(input, nowIso());
  console.log(formatDqReport(report));
  if (notes.length) {
    console.log(C.dim('\n主数据提示：'));
    printNotes(notes);
  }
  const byRule = summarizeByRule(report);
  if (byRule.length) {
    console.log(C.dim('\n按规则分布：'));
    for (const r of byRule) console.log(`  ${r.ruleId.padEnd(28)} ${r.count} 条 (${r.severity})`);
  }
  return report.passed ? 0 : 1;
}

function cmdBuild(args: Args): number {
  const { input, notes, fatal } = loadBuildInput();
  if (fatal.length) {
    for (const f of fatal) console.error(C.red(`✖ ${f}`));
    return 2;
  }

  const generatedAt = nowIso();
  let result;
  try {
    result = buildSnapshot(input, {
      generatedAt,
      pipelineVersion: SCHEMA_VERSION,
    });
  } catch (err) {
    if (err instanceof DqBlockedError) {
      console.error(formatDqReport(err.report));
      console.error(C.red(`\n✖ ${err.message}`));
      console.error(C.dim('已按设计不产出快照 —— 宁可今天没有新数据，也不让错数据进入可信链路。'));
      return 1;
    }
    throw err;
  }

  console.log(C.green('✅ 数据质量闸门通过'));
  if (result.dq.warnCount) {
    console.log(C.yellow(`   有 ${result.dq.warnCount} 条 warn，已随快照下发，前端「质量中心」会常驻提示。`));
    for (const f of result.dq.findings.filter((x) => x.severity === 'warn')) {
      console.log(C.yellow(`   · ${f.ruleId} @ ${f.scope}`));
    }
  }

  if (args.flags['no-encrypt'] === true) {
    console.log(C.red('⚠ 已指定 --no-encrypt：产物为明文，仅限本地调试，切勿发布。'));
  }

  const key = resolvePassword(args.flags.key as string | undefined);
  let payload;
  if (key.password) {
    for (const w of passwordWarnings(key.password)) console.log(C.yellow(`  ⚠ ${w}`));
    payload = encryptSnapshot(result.snapshot, key.password);
    console.log(C.dim(`   加密：${payload.cipher} / KDF ${payload.kdf.name}-${payload.kdf.hash} × ${payload.kdf.iterations}`));
  } else {
    console.error(C.red(`✖ ${key.note}`));
    return 2;
  }
  const _ = key.source;

  const files = writeSnapshot(payload, args.flags.force === true);
  console.log(C.green(`✅ 快照已生成 → ${files.jsFile}`));
  console.log(C.dim(`   ${files.jsPath}`));

  if (args.flags['no-publish'] !== true) {
    const webPublic = join(PATHS.root, 'packages', 'web', 'public');
    const published = publishTo(payload, files, { dir: webPublic, latestName: 'marketing-data.latest.json' });
    console.log(C.green(`✅ 已发布到前端目录（${published.copies.length} 个文件）`));
  }

  const manifest = commitSnapshot({
    file: files.jsFile,
    generatedAt,
    period: result.snapshot.period,
    blockCount: result.dq.blockCount,
  });
  console.log(C.dim(`   manifest.current = ${manifest.current}（上一版 ${manifest.previous ?? '无'}）`));
  if (notes.length) printNotes(notes);

  console.log(C.dim('\n下一步：cd packages/web && npm run build，然后提交部署。'));
  return 0;
}

/* ------------------------------------------------------------------ *
 * rollback / history / doctor
 * ------------------------------------------------------------------ */
function cmdRollback(args: Args): number {
  const r = rollback(args.flags.to as string | undefined);
  console.log(r.ok ? C.green(`✅ ${r.message}`) : C.red(`✖ ${r.message}`));
  console.log(C.dim('历史快照一律保留，任何一版都可随时切回。'));
  return r.ok ? 0 : 1;
}

function cmdHistory(): number {
  const snapshots = listSnapshots();
  const manifest = readManifest();
  if (!snapshots.length) {
    console.log('尚无任何快照。');
    return 0;
  }
  console.log(C.bold(`历史快照（共 ${snapshots.length} 版，永不删除）`));
  for (const s of snapshots) {
    const mark = s.file === manifest?.current ? C.green('← 当前生效') : '';
    console.log(`  ${s.file.padEnd(34)} ${(s.size / 1024).toFixed(1).padStart(8)} KB  ${mark}`);
  }
  return 0;
}

function cmdDoctor(): number {
  console.log(C.bold(`origoaura-ops · doctor`));
  console.log(`  node         ${process.version}`);
  console.log(`  schemaVersion ${SCHEMA_VERSION}`);
  console.log(`  工程根目录    ${PATHS.root}`);

  let bad = 0;
  const check = (label: string, ok: boolean, hint = ''): void => {
    console.log(`  ${ok ? C.green('✔') : C.red('✖')} ${label}${ok || !hint ? '' : C.dim(`  ← ${hint}`)}`);
    if (!ok) bad += 1;
  };

  check('C1 列名契约', CANONICAL_COLUMNS.length === 31, `当前 ${CANONICAL_COLUMNS.length} 列，应为 31`);
  check('DQ 规则注册表', ALL_RULE_IDS.length >= 10, `当前 ${ALL_RULE_IDS.length} 条`);

  for (const f of ['sku-bom.json', 'platform-fees.json', 'tax-rates.json', 'inventory.json', 'targets.json'] as const) {
    check(`主数据 ${f}`, existsSync(masterPath(f)), '缺失时对应模块会显示空态或标注「未计入」');
  }
  check('tax-rates.json（合规必需）', existsSync(masterPath('tax-rates.json')), '缺失将拒绝 build');

  const key = resolvePassword();
  check('解密口令', key.password !== null, key.note.split('\n')[0]);

  const canonical = readCanonical();
  check('canonical 数据集', canonical !== null, '先运行 origo ingest');
  if (canonical) {
    console.log(C.dim(`     日报 ${canonical.daily.length} 行 · SKU×日 ${canonical.skuDaily.length} 行`));
  }

  const inv = loadInventory();
  const tg = loadTargets();
  console.log(C.dim(`     库存主数据 ${inv.found ? `${inv.value.length} 条` : '缺失（供应链机会显示空态）'}`));
  console.log(C.dim(`     经营目标 ${tg.found ? '已配置' : '缺失（达成率将提示「未设置目标」）'}`));

  const plat = inferPlatform('小红书_商品分析_202609.xlsx');
  console.log(C.dim(`     平台识别自检：小红书_商品分析_202609.xlsx → ${plat ?? '未识别'}`));

  console.log(bad === 0 ? C.green('\n全部检查通过。') : C.yellow(`\n有 ${bad} 项需要处理。`));
  return 0;
}

function usage(): void {
  console.log(
    [
      C.bold('origoaura-ops · 数据管道'),
      '',
      '  origo ingest <文件...> [--kind auto|monthly|flat|sku] [--profile default] [--platform tiktok]',
      '                         [--sheets "9月汇总,10月汇总"]  只解析指定工作表',
      '  origo validate',
      '  origo build [--key <口令>] [--force] [--no-publish] [--no-encrypt]',
      '  origo rollback [--to <快照文件名>]',
      '  origo history',
      '  origo doctor',
      '',
      C.dim('口径计算全部在 @origo/core，本 CLI 只做读文件 / 写文件 / 打印。'),
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */
function main(): number {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (!cmd || args.flags.help === true) {
    usage();
    return cmd ? 0 : 2;
  }

  switch (cmd) {
    case 'ingest':
      return cmdIngest(args);
    case 'validate':
      return cmdValidate(args);
    case 'build':
      return cmdBuild(args);
    case 'rollback':
      return cmdRollback(args);
    case 'history':
      return cmdHistory();
    case 'doctor':
      return cmdDoctor();
    default:
      console.error(C.red(`未知命令：${cmd}`));
      usage();
      return 2;
  }
}

// 仅在被直接执行时运行；被 import 时不退出进程（便于测试与 doctor 复用）
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(main());
}
