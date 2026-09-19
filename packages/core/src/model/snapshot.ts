/**
 * L5 · model/snapshot —— 版本化快照信封（ADR-06）
 *
 * 三条不可让步的规则（SAD §4.3 / §11）：
 *  1. schemaVersion 遵循 semver，破坏性变更升 major，前端加载时做版本协商；
 *  2. 每次 build 产出**不可变**文件 marketing-data.<yyyymmddhhmm>.js + manifest.json；
 *     历史快照永不物理删除（C5），只允许更正留痕；
 *  3. 加密是「防明文抓取」而非「权限隔离」—— 前端内置解密密钥，
 *     真权限在 V12 解决。此局限必须在文档与界面如实标注。
 */

import type { DailyRecord, ISODate } from './daily.ts';
import type { CostPolicy, TaxParams } from './finance.ts';
import type { SkuDaily, SkuMaster } from './sku.ts';
import type { InventoryItem } from './supply.ts';
import type { Targets } from '../compute/alerts.ts';

/** 当前 schema 版本（semver）。任何破坏性结构变更必须升 major。 */
export const SCHEMA_VERSION = '10.0.0';

/** 数据质量结论 */
export type DqSeverity = 'block' | 'warn';

export interface DqFinding {
  ruleId: string;
  severity: DqSeverity;
  /** 定位：'2026-07-15/taobao' 或 '2026-07' */
  scope: string;
  /** 期望值（勾稽等式右边） */
  expected: number;
  /** 实际值（勾稽等式左边） */
  actual: number;
  /** 差异 = actual − expected */
  diff: number;
  message: string;
  /** 已知差异的人工备注（留痕，不静默 —— SAD §5.3） */
  acknowledged?: string;
}

export interface DqReport {
  passed: boolean;
  /** 执行时间（由调用方注入，内核不取当前时间） */
  ranAt: string;
  blockCount: number;
  warnCount: number;
  findings: DqFinding[];
  /** 已执行规则总数，用于前端展示覆盖率 */
  rulesRun: number;
}

/** 版本化快照信封 —— 前端渲染与管道产出的唯一契约 */
export interface Snapshot {
  schemaVersion: string;
  /** ISO datetime，由管道注入 */
  generatedAt: string;
  period: { start: ISODate; end: ISODate };

  daily: DailyRecord[];
  skuMaster: SkuMaster[];
  /** SKU 维度可选（B2）；无源数据时为空数组，前端据 SkuMaster 判空态 */
  skuDaily: SkuDaily[];

  costPolicy: CostPolicy;
  taxParams: TaxParams;

  dqReport: DqReport;

  /**
   * 库存主数据（供应链页）。
   * **可选**：早期快照没有这一节；缺失时前端渲染空态而不是假 0（ADR-08）。
   */
  inventory?: InventoryItem[];

  /**
   * 经营目标（预警达成率）。
   * 刻意保留 `null` 语义：月度营收目标未设置时值为 null，
   * 前端据此提示「未设置目标」，而不是臆造一个 100% 达成率。
   */
  targets?: Partial<Targets>;

  /** 各分区内容的校验和，用于跨端一致性断言 */
  checksums: Record<string, string>;

  /** 产出该快照的管道版本，便于回溯 */
  pipelineVersion?: string;
}

/** 解析 semver，非法返回 null */
export function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if ([major, minor, patch].some((n) => !Number.isFinite(n))) return null;
  return { major, minor, patch };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`版本号非法：${!pa ? a : b}`);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

/**
 * 迁移函数链：migrate(v → v+1)。
 * 旧快照加载时逐级升到当前版本后再渲染，实现"向前兼容"。
 * V10 是首个版本，链为空；新增版本时在此注册。
 */
export const MIGRATIONS: Record<string, (s: unknown) => unknown> = {
  // 例：'10.0.0→10.1.0': (s) => ({ ...(s as object), newField: [] }) as unknown,
};

/** 把任意版本的快照升到 SCHEMA_VERSION；无法升级时抛出可读错误 */
export function migrateToCurrent(raw: unknown, target = SCHEMA_VERSION): unknown {
  let cur = raw as Snapshot;
  let guard = 0;
  while (compareSemver(cur.schemaVersion, target) < 0) {
    const next = nextMinorOrMajor(cur.schemaVersion);
    const key = `${cur.schemaVersion}→${next}`;
    const fn = MIGRATIONS[key];
    if (!fn) {
      throw new Error(
        `缺少迁移函数 ${key}：快照版本 ${cur.schemaVersion} 无法升级到 ${target}。` +
          `请在 model/snapshot.ts 的 MIGRATIONS 注册该步骤。`,
      );
    }
    cur = fn(cur) as Snapshot;
    guard += 1;
    if (guard > 100) throw new Error('迁移链疑似死循环，请检查 MIGRATIONS 注册');
  }
  const newer = compareSemver(cur.schemaVersion, target);
  if (newer > 0) {
    throw new Error(
      `快照版本 ${cur.schemaVersion} 高于前端支持版本 ${target}，请升级前端后再打开。`,
    );
  }
  return cur;
}

function nextMinorOrMajor(v: string): string {
  const p = parseSemver(v);
  if (!p) throw new Error(`版本号非法：${v}`);
  return `${p.major}.${p.minor + 1}.0`;
}

/** 快照文件名（不可变）：marketing-data.<yyyymmddhhmm>.js */
export function snapshotFileName(generatedAtIso: string): string {
  const d = generatedAtIso.replace(/[-:T.]/g, '');
  const stamp = d.slice(0, 12); // yyyymmddhhmm
  return `marketing-data.${stamp}.js`;
}

/** manifest.json —— 指向上一个/最新快照，支持一键回滚 */
export interface SnapshotManifest {
  schemaVersion: string;
  /** 当前生效的快照文件名 */
  current: string;
  /** 上一版快照文件名（回滚目标） */
  previous: string | null;
  /** 全部历史快照（新→旧），永不物理删除（C5） */
  history: { file: string; generatedAt: string; period: { start: ISODate; end: ISODate }; blockCount: number }[];
}
