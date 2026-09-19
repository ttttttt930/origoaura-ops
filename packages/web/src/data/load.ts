/**
 * L6 · data/load —— 快照装载
 *
 * 流程（顺序不可换）：
 *   fetch 加密信封 → WebCrypto 解密 → 校验和复核 → **schemaVersion 协商** → 得到 Snapshot
 *
 * 为什么必须做版本协商（SAD §4.3）：
 *   静态站点无法保证"前端产物"与"数据快照"同时发布。若快照比前端新，
 *   直接渲染会读到不存在的字段而静默出错。宁可给出可读的升级提示。
 */

import { migrateToCurrent, SCHEMA_VERSION, type Snapshot } from '@origo/core';
import { DecryptError, decryptSnapshot, type EncryptedPayload } from './crypto.ts';

export const SNAPSHOT_ENTRY = 'marketing-data.latest.json';

export interface LoadResult {
  snapshot: Snapshot;
  /** 快照自身的版本（迁移前） */
  sourceSchemaVersion: string;
  /** 是否发生了版本迁移 */
  migrated: boolean;
  /** 前端支持的版本 */
  frontendSchemaVersion: string;
  checksumResults: { key: string; expected: string; actual: string; ok: boolean }[];
  allChecksumsOk: boolean;
}

export class LoadError extends Error {
  readonly kind: 'network' | 'format' | 'password' | 'corrupt' | 'version';
  readonly detail?: string;
  constructor(kind: LoadError['kind'], message: string, detail?: string) {
    super(message);
    this.name = 'LoadError';
    this.kind = kind;
    this.detail = detail;
  }
}

function entryUrl(): string {
  const base = import.meta.env.BASE_URL || './';
  return `${base}${SNAPSHOT_ENTRY}`;
}

/** 只取信封，不解密 —— 用于"锁屏上展示数据版本"这类无口令场景 */
export async function fetchEnvelope(): Promise<EncryptedPayload> {
  let res: Response;
  try {
    res = await fetch(entryUrl(), { cache: 'no-cache' });
  } catch (e) {
    throw new LoadError('network', `无法读取数据文件 ${SNAPSHOT_ENTRY}：${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new LoadError('network', `数据文件返回 HTTP ${res.status}。请确认快照已发布到站点根目录。`);
  }
  try {
    return (await res.json()) as EncryptedPayload;
  } catch {
    throw new LoadError('format', '数据文件不是合法 JSON，可能被 CDN 缓存了半截内容，请强刷。');
  }
}

export async function loadSnapshot(password: string): Promise<LoadResult> {
  const env = await fetchEnvelope();

  let decrypted: Awaited<ReturnType<typeof decryptSnapshot>>;
  try {
    decrypted = await decryptSnapshot(env, password);
  } catch (e) {
    if (e instanceof DecryptError) {
      throw new LoadError(e.kind === 'password' ? 'password' : 'corrupt', e.message);
    }
    throw new LoadError('corrupt', (e as Error).message);
  }

  const raw = decrypted.plain as Snapshot;
  const sourceSchemaVersion = String(raw.schemaVersion ?? '');

  let migrated = false;
  let snapshot: Snapshot;
  try {
    const upgraded = migrateToCurrent(raw, SCHEMA_VERSION) as Snapshot;
    migrated = upgraded.schemaVersion !== sourceSchemaVersion;
    snapshot = upgraded;
  } catch (e) {
    throw new LoadError(
      'version',
      (e as Error).message,
      `快照 ${sourceSchemaVersion} · 前端支持 ${SCHEMA_VERSION}`,
    );
  }

  return {
    snapshot,
    sourceSchemaVersion,
    migrated,
    frontendSchemaVersion: SCHEMA_VERSION,
    checksumResults: decrypted.checksumResults,
    allChecksumsOk: decrypted.allChecksumsOk,
  };
}

/** 注入给内核的"今天"。内核刻意不取当前时间（可测性），由表现层注入。 */
export function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 快照内最后一个**有数据**的日期（用于"数据截至"提示，而非"文件截止"） */
export function lastActiveDate(snapshot: Snapshot): string | null {
  let last: string | null = null;
  for (const r of snapshot.daily) {
    if (r.revenue === 0 && r.refund === 0 && r.promotion === 0 && r.qty === 0) continue;
    if (last === null || r.date > last) last = r.date;
  }
  return last;
}
