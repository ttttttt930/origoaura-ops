/**
 * L4 · snapshot/build —— 组装版本化快照（ADR-06）
 *
 * 顺序不可调换：
 *   规范化数据 → 分组 → **DQ 闸门** → （block 则抛错终止，不产出快照）→ 组装信封 → 校验和
 *
 * 「不产出快照」是硬承诺（SAD §5.3）：宁可当天没有新数据，
 * 也不能让带错的数据进入可信链路 —— 7 月那 ¥6,391 就是这么进去的。
 */

import { createHash } from 'node:crypto';
import {
  SCHEMA_VERSION,
  groupDays,
  runDq,
  stableStringify,
  type CostPolicy,
  type DailyRecord,
  type DqReport,
  type InventoryItem,
  type SkuDaily,
  type SkuMaster,
  type Snapshot,
  type Targets,
  type TaxParams,
} from '@origo/core';
import type { CanonicalSet } from '../store/canonical.ts';
import { dateRange } from '../store/canonical.ts';

export interface BuildInput {
  canonical: CanonicalSet;
  skuMaster: readonly SkuMaster[];
  costPolicy: CostPolicy;
  taxParams: TaxParams;
  acknowledged: Record<string, string>;
  market?: 'cn' | 'overseas';
  /** 库存主数据（供应链页消费）；不传则不写入快照，前端显示空态 */
  inventory?: InventoryItem[];
  /** 经营目标；未设置的项显式传 null，前端据此提示「未设置目标」 */
  targets?: Partial<Targets>;
}

export interface BuildOptions {
  /** 生成时间，由调用方注入（内核不取当前时间） */
  generatedAt: string;
  pipelineVersion?: string;
}

export interface BuildResult {
  snapshot: Snapshot;
  dq: DqReport;
}

/**
 * 指纹 = 内核的 stableStringify（键排序）→ SHA-256。
 *
 * 刻意复用内核实现而不是在这里再写一份：
 * 前端用的是 WebCrypto + 同一份 stableStringify，只有两边序列化逐字节相同，
 * "浏览器算出来的校验和 == Node 算出来的校验和" 才成立。
 */
export function sha256(v: unknown): string {
  return createHash('sha256').update(stableStringify(v)).digest('hex');
}

/**
 * 计算各分区校验和。
 * 前端加载快照后会重算同一份指纹并比对，用于发现"传输/缓存把数据搞坏了"。
 *
 * 可选分区（inventory / targets）**只在写入快照时才计入** —— 否则旧快照重算校验和
 * 时会对多出来的键比对失败，把"老数据"误报成"数据损坏"。
 */
export function checksums(snap: Omit<Snapshot, 'checksums'>): Record<string, string> {
  const out: Record<string, string> = {
    daily: sha256(snap.daily),
    skuMaster: sha256(snap.skuMaster),
    skuDaily: sha256(snap.skuDaily),
    costPolicy: sha256(snap.costPolicy),
    taxParams: sha256(snap.taxParams),
    dqReport: sha256(snap.dqReport),
  };
  if (snap.inventory !== undefined) out.inventory = sha256(snap.inventory);
  if (snap.targets !== undefined) out.targets = sha256(snap.targets);
  return out;
}

/** 运行 DQ（供 validate / build 共用） */
export function validate(input: BuildInput, ranAt: string): DqReport {
  const days = groupDays(input.canonical.daily);
  return runDq(
    days,
    {
      allDates: input.canonical.allDates,
      declaredColumns: input.canonical.declaredColumns,
      parsedColumns: input.canonical.parsedColumns,
      derivedColumns: input.canonical.derivedColumns ?? [],
      skuMaster: input.skuMaster,
      observedSkus: input.canonical.observedSkus,
      cellIssues: input.canonical.cellIssues ?? [],
      market: input.market ?? 'cn',
      acknowledged: input.acknowledged,
    },
    ranAt,
  );
}

export class DqBlockedError extends Error {
  /**
   * 注意：这里刻意不用 TS 的「参数属性」写法（constructor(readonly x: T)），
   * 因为 Node 的类型擦除（strip-only）模式不支持该语法，会在运行时报错。
   */
  readonly report: DqReport;

  constructor(report: DqReport) {
    super(
      `数据质量闸门未通过：${report.blockCount} 条 block，已阻止生成快照。` +
        `请修复后重跑；若属已知差异，请在 data/master/dq-acknowledged.json 留痕（留痕不豁免 block）。`,
    );
    this.name = 'DqBlockedError';
    this.report = report;
  }
}

/** 组装快照；存在 block 时抛 DqBlockedError（不返回半成品） */
export function buildSnapshot(input: BuildInput, opts: BuildOptions): BuildResult {
  const dq = validate(input, opts.generatedAt);
  if (!dq.passed) throw new DqBlockedError(dq);

  const period = dateRange(input.canonical.daily.map((d) => d.date));

  const withoutChecksums: Omit<Snapshot, 'checksums'> = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: opts.generatedAt,
    period,
    daily: input.canonical.daily,
    skuMaster: [...input.skuMaster],
    skuDaily: input.canonical.skuDaily,
    costPolicy: input.costPolicy,
    taxParams: input.taxParams,
    dqReport: dq,
    // 可选分区：只有拿到真值才写进快照，否则前端会把它渲染成"0 条/全 null"
    ...(input.inventory && input.inventory.length ? { inventory: [...input.inventory] } : {}),
    ...(input.targets ? { targets: input.targets } : {}),
    ...(opts.pipelineVersion ? { pipelineVersion: opts.pipelineVersion } : {}),
  };

  const snapshot: Snapshot = { ...withoutChecksums, checksums: checksums(withoutChecksums) };
  return { snapshot, dq };
}

/** 供测试与 doctor 使用的空快照构造器 */
export function emptyCanonical(generatedAt: string): CanonicalSet {
  return {
    generatedAt,
    sources: [],
    daily: [] as DailyRecord[],
    skuDaily: [] as SkuDaily[],
    parsedColumns: [],
    declaredColumns: [],
    derivedColumns: [],
    allDates: [],
    observedSkus: [],
    cellIssues: [],
    notes: [],
  };
}
