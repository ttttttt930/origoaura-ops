/**
 * L4 · store/canonical —— 规范化结果落盘（data/canonical/）
 *
 * 定位：管道内部的可复算中间态，**不进 git**（见 .gitignore）。
 * 与 snapshot 的区别：canonical 是明文、可重算；snapshot 是加密、不可变、要留痕。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DailyRecord, SkuDaily } from '@origo/core';
import { PATHS, ensureDir } from '../config/paths.ts';

export interface CanonicalSource {
  file: string;
  /** 文件最后修改时间（ISO），用于"数据是否比快照新"的判定 */
  mtime: string;
  /** 内容指纹，防止同名不同内容被当成同一批 */
  sha256: string;
}

export interface CanonicalSet {
  /** 生成时间（由调用方注入） */
  generatedAt: string;
  sources: CanonicalSource[];
  daily: DailyRecord[];
  skuDaily: SkuDaily[];
  parsedColumns: string[];
  declaredColumns: string[];
  /** 源文件里不存在、只能由各平台推导的规范列（如分组布局下的「总退款」） */
  derivedColumns: string[];
  /** 每个源行一个日期（重复 = 重复导入） */
  allDates: string[];
  /** 观测到的商品名 */
  observedSkus: string[];
  /** 单元格格式问题（文本型数字 / 无法解析），供 DQ 报 warn */
  cellIssues: { scope: string; coerced: number; invalid: number; samples: string[] }[];
  /** 规范化过程中的全部提示 */
  notes: string[];
}

export function canonicalPath(): string {
  return join(PATHS.canonical, 'canonical.json');
}

export function writeCanonical(set: CanonicalSet): string {
  ensureDir(PATHS.canonical);
  const path = canonicalPath();
  writeFileSync(path, JSON.stringify(set, null, 2), 'utf8');
  return path;
}

export function readCanonical(): CanonicalSet | null {
  const path = canonicalPath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as CanonicalSet;
}

/** 汇总去重后的日期范围，供快照 period 使用 */
export function dateRange(dates: readonly string[]): { start: string; end: string } {
  if (!dates.length) return { start: '', end: '' };
  const sorted = [...dates].sort();
  return { start: sorted[0]!, end: sorted[sorted.length - 1]! };
}
