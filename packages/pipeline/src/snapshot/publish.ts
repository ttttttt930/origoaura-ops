/**
 * L4 · snapshot/publish —— 把加密快照落到发布目录
 *
 * 产出两份同内容、不同载体的文件：
 *   marketing-data.<stamp>.js   ES module（工具链 / 测试 / 静态分析可直接 import）
 *   marketing-data.<stamp>.json 纯数据（浏览器 fetch 用，避免把密钥与解密逻辑耦合进打包）
 *
 * 为什么两份：SAD 要求文件名是 .js（便于审计与按名回溯），
 * 而运行时用 fetch + WebCrypto 解密更简单、也更容易做缓存穿透（?bust=）。
 */

import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotFileName } from '@origo/core';
import type { EncryptedPayload } from './encrypt.ts';
import { PATHS, ensureDir } from '../config/paths.ts';
import { snapshotDir } from './manifest.ts';

export interface PublishTarget {
  /** 发布目录（如 packages/web/public） */
  dir: string;
  /** 同时写入的固定文件名（供 SPA 默认加载）；null 表示不写 */
  latestName?: string | null;
}

export interface PublishedFiles {
  jsFile: string;
  jsonFile: string;
  jsPath: string;
  jsonPath: string;
  copies: string[];
}

/** 序列化为 ES module 文本 */
export function toModuleSource(enc: EncryptedPayload): string {
  return [
    '/* 自动生成，请勿手改 —— 由 origoaura-ops pipeline 产出 */',
    '/* 加密仅防明文抓取，密钥内置于前端，不构成权限隔离（见 ADR-06）。 */',
    `export const SCHEMA_VERSION = ${JSON.stringify(enc.schemaVersion)};`,
    `export const GENERATED_AT = ${JSON.stringify(enc.generatedAt)};`,
    `export const KDF = ${JSON.stringify(enc.kdf)};`,
    `export const CIPHER = ${JSON.stringify(enc.cipher)};`,
    `export const SALT = ${JSON.stringify(enc.salt)};`,
    `export const IV = ${JSON.stringify(enc.iv)};`,
    `export const PAYLOAD = ${JSON.stringify(enc.payload)};`,
    `export const PLAIN_SHA256 = ${JSON.stringify(enc.plainSha256)};`,
    `export const CHECKSUMS = ${JSON.stringify(enc.checksums)};`,
    'export default { SCHEMA_VERSION, GENERATED_AT, KDF, CIPHER, SALT, IV, PAYLOAD, PLAIN_SHA256, CHECKSUMS };',
    '',
  ].join('\n');
}

/** 写入不可变快照（同名文件已存在时**拒绝覆盖**，保护历史留痕） */
export function writeSnapshot(enc: EncryptedPayload, force = false): PublishedFiles {
  ensureDir(snapshotDir());
  const base = snapshotFileName(enc.generatedAt);
  const jsFile = base;
  const jsonFile = base.replace(/\.js$/, '.json');
  const jsPath = join(snapshotDir(), jsFile);
  const jsonPath = join(snapshotDir(), jsonFile);

  const json = `${JSON.stringify(enc, null, 2)}\n`;
  try {
    if (!force) {
      writeFileSync(jsPath, toModuleSource(enc), { encoding: 'utf8', flag: 'wx' });
      writeFileSync(jsonPath, json, { encoding: 'utf8', flag: 'wx' });
    } else {
      writeFileSync(jsPath, toModuleSource(enc), 'utf8');
      writeFileSync(jsonPath, json, 'utf8');
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EEXIST') {
      throw new Error(
        `快照 ${jsFile} 已存在。历史快照不可覆盖（C5）。` +
          `若确实要重算同一分钟，请稍后再构建，或用 --force（会破坏不可变性）。`,
      );
    }
    throw err;
  }

  return { jsFile, jsonFile, jsPath, jsonPath, copies: [] };
}

/** 额外复制到发布目录（web/public），并写一份 latest 别名供 SPA 默认加载 */
export function publishTo(enc: EncryptedPayload, files: PublishedFiles, target: PublishTarget): PublishedFiles {
  ensureDir(target.dir);
  const copies: string[] = [];
  for (const src of [files.jsPath, files.jsonPath]) {
    const dst = join(target.dir, src.split('/').pop()!);
    copyFileSync(src, dst);
    copies.push(dst);
  }
  if (target.latestName) {
    const latest = join(target.dir, target.latestName);
    writeFileSync(latest, `${JSON.stringify(enc, null, 2)}\n`, 'utf8');
    copies.push(latest);
  }
  return { ...files, copies };
}

export { PATHS };
