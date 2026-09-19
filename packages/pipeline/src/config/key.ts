/**
 * L4 · config/key —— 加解密口令解析
 *
 * 优先级：命令行 --key > 环境变量 ORIGO_PASSWORD > 工程根目录 .origo-key 文件。
 * 三者都没有时**拒绝构建**，而不是生成一份"没加密"的快照冒充加密产物。
 * （本地调试可用 --no-encrypt，但会在输出里打显著警告。）
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './paths.ts';

export const KEY_FILE = '.origo-key';

export interface KeyResult {
  password: string | null;
  source: 'cli' | 'env' | 'file' | 'none';
  note: string;
}

export function resolvePassword(explicit?: string): KeyResult {
  if (explicit) return { password: explicit, source: 'cli', note: '口令来自命令行参数。' };

  const env = process.env.ORIGO_PASSWORD;
  if (env) return { password: env, source: 'env', note: '口令来自环境变量 ORIGO_PASSWORD。' };

  const file = join(PATHS.root, KEY_FILE);
  if (existsSync(file)) {
    const pw = readFileSync(file, 'utf8').trim();
    if (pw) return { password: pw, source: 'file', note: `口令来自 ${KEY_FILE}。` };
  }

  return {
    password: null,
    source: 'none',
    note:
      '未找到解密口令。请任选一种方式提供：\n' +
      '  · 命令行：origo build --key "<口令>"\n' +
      '  · 环境变量：export ORIGO_PASSWORD="<口令>"\n' +
      `  · 文件：在工程根目录创建 ${KEY_FILE} 并写入口令（已在 .gitignore 中）`,
  };
}

/** 密码强度仅做最低限度提醒（不阻断，避免影响本地迭代） */
export function passwordWarnings(pw: string): string[] {
  const out: string[] = [];
  if (pw.length < 8) out.push('口令长度不足 8 位，建议加长（PBKDF2 150k 迭代对短口令的暴力破解保护有限）。');
  if (/^\d+$/.test(pw)) out.push('口令为纯数字，建议混合大小写字母与符号。');
  return out;
}
