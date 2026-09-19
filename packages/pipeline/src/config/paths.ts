/**
 * L4 · config/paths —— 工程路径解析
 *
 * 管道是唯一允许碰文件系统的层，所有路径都从这里取，禁止在业务代码里拼字符串。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** origoaura-ops/ 根目录（src/config → src → pipeline → packages → root） */
export const ROOT = resolve(HERE, '..', '..', '..', '..');

export const PATHS = {
  root: ROOT,
  data: join(ROOT, 'data'),
  master: join(ROOT, 'data', 'master'),
  raw: join(ROOT, 'data', 'raw'),
  canonical: join(ROOT, 'data', 'canonical'),
  snapshots: join(ROOT, 'data', 'snapshots'),
  docs: join(ROOT, 'docs'),
} as const;

export type MasterFileName =
  | 'sku-bom.json'
  | 'platform-fees.json'
  | 'tax-rates.json'
  | 'targets.json'
  | 'inventory.json'
  | 'dq-acknowledged.json';

export function masterPath(file: MasterFileName): string {
  return join(PATHS.master, file);
}

export function columnMappingPath(profile: string): string {
  return join(PATHS.master, 'column-mappings', `${profile}.json`);
}

/** 幂等创建目录，返回该路径 */
export function ensureDir(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}
