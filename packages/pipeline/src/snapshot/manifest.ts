/**
 * L4 · snapshot/manifest —— 快照清单与回滚（ADR-06 / C5）
 *
 * 铁律：**历史快照永不物理删除**。manifest 只记录"当前生效的是哪一个"，
 * 回滚就是把 current 指回 previous —— 秒级、可审计、无损。
 *
 * 若某次构建发现问题，正确动作是"再构建一版正确的"，而不是删掉错的那版。
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION, snapshotFileName, type ISODate, type SnapshotManifest } from '@origo/core';
import { PATHS, ensureDir } from '../config/paths.ts';

export const MANIFEST_FILE = 'manifest.json';

export function snapshotDir(): string {
  return PATHS.snapshots;
}

export function manifestPath(): string {
  return join(snapshotDir(), MANIFEST_FILE);
}

export function readManifest(): SnapshotManifest | null {
  const p = manifestPath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as SnapshotManifest;
}

/** 写入/更新清单：把新快照置为 current，原 current 降为 previous */
export function commitSnapshot(entry: {
  file: string;
  generatedAt: string;
  period: { start: ISODate; end: ISODate };
  blockCount: number;
}): SnapshotManifest {
  ensureDir(snapshotDir());
  const prev = readManifest();
  const history = [entry, ...(prev?.history ?? []).filter((h) => h.file !== entry.file)];
  const manifest: SnapshotManifest = {
    schemaVersion: SCHEMA_VERSION,
    current: entry.file,
    previous: prev?.current ?? null,
    history,
  };
  writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

export interface RollbackResult {
  ok: boolean;
  from: string | null;
  to: string | null;
  message: string;
  manifest?: SnapshotManifest;
}

/**
 * 回滚到上一版；也可指定 `to`（必须是 history 里存在的文件）。
 * 回滚本身也写进 manifest（previous 互换），因此可以来回切。
 */
export function rollback(to?: string): RollbackResult {
  const manifest = readManifest();
  if (!manifest) {
    return { ok: false, from: null, to: null, message: '没有 manifest.json，无可回滚的快照。' };
  }
  const target = to ?? manifest.previous;
  if (!target) {
    return { ok: false, from: manifest.current, to: null, message: '当前没有更早的快照可回滚。' };
  }
  if (!manifest.history.some((h) => h.file === target)) {
    return {
      ok: false,
      from: manifest.current,
      to: target,
      message: `快照 ${target} 不在 history 中，拒绝回滚（避免指向不存在的文件）。`,
    };
  }
  if (!existsSync(join(snapshotDir(), target))) {
    return { ok: false, from: manifest.current, to: target, message: `快照文件 ${target} 不存在。` };
  }

  const next: SnapshotManifest = {
    ...manifest,
    current: target,
    previous: manifest.current,
  };
  writeFileSync(manifestPath(), JSON.stringify(next, null, 2), 'utf8');
  return {
    ok: true,
    from: manifest.current,
    to: target,
    message: `已回滚：${manifest.current} → ${target}（${manifest.current} 仍保留在 history 中，可再切回）。`,
    manifest: next,
  };
}

/** 列出磁盘上的全部快照（按时间倒序），用于 doctor 与"历史快照"页 */
export function listSnapshots(): { file: string; size: number; mtime: string }[] {
  const dir = snapshotDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('marketing-data.') && f.endsWith('.js'))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { file: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.file < b.file ? 1 : -1));
}

export { snapshotFileName };
