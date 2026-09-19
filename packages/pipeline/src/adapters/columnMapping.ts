/**
 * L4 · adapters/columnMapping —— 列映射（ADR-04）
 *
 * 平台一改版（加列 / 改名 / 换位置），**只改 data/master/column-mappings/*.json**，
 * 不碰任何代码。这是 C4（4→5 平台演进）与 C1（列名契约）能同时成立的唯一办法。
 */

import { existsSync, readFileSync } from 'node:fs';
import { CANONICAL_COLUMNS } from '@origo/core';
import { columnMappingPath } from '../config/paths.ts';

export interface ColumnMapping {
  /** 映射配置文件名（去 .json） */
  profile: string;
  /** 说明 */
  description?: string;
  /** 工作表名，缺省取第一个 */
  sheet?: string;
  /**
   * 日期列名。映射到规范列 `date`。
   * 允许写成 ['日期', 'date'] 形式以兼容不同导出。
   */
  dateColumns: string[];
  /** 源列名 → 规范列名（规范列名必须是 CANONICAL_COLUMNS 之一） */
  columns: Record<string, string>;
  /** 明确忽略的源列（备注、操作人等），忽略它们不会触发列漂移告警 */
  ignore?: string[];
  /** 日期解析方式 */
  dateFormat?: 'auto' | 'excel-serial' | 'iso';
}

/** 默认映射：源列名与规范列名同名（历史上就是 31 列直读） */
export function defaultMapping(): ColumnMapping {
  const columns: Record<string, string> = {};
  for (const c of CANONICAL_COLUMNS) columns[c] = c;
  return {
    profile: 'default',
    description: '营销发展日报.xlsx 默认映射：源列名即规范列名。',
    dateColumns: ['日期', 'date', '日期(YYYY-MM-DD)'],
    columns,
    ignore: ['备注', '备注列', '备注说明', '操作人'],
    dateFormat: 'auto',
  };
}

export interface MappingLoadResult {
  mapping: ColumnMapping;
  found: boolean;
  notes: string[];
}

/** 加载映射；文件不存在时回落到默认映射（并给出提示，不静默） */
export function loadColumnMapping(profile = 'default'): MappingLoadResult {
  const path = columnMappingPath(profile);
  if (!existsSync(path)) {
    return {
      mapping: defaultMapping(),
      found: false,
      notes: [`未找到列映射 ${profile}.json，使用默认映射（源列名 = 规范列名）。`],
    };
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ColumnMapping>;
  const base = defaultMapping();
  const mapping: ColumnMapping = {
    ...base,
    ...raw,
    profile,
    columns: { ...base.columns, ...(raw.columns ?? {}) },
  };
  return { mapping, found: true, notes: validateMapping(mapping) };
}

/** 校验映射：目标列必须是规范列，否则平台改版会悄悄改坏口径 */
export function validateMapping(m: ColumnMapping): string[] {
  const canonical = new Set<string>(CANONICAL_COLUMNS);
  const notes: string[] = [];
  for (const [src, dst] of Object.entries(m.columns)) {
    if (!canonical.has(dst)) {
      notes.push(`列映射非法：源列「${src}」被映射到未知规范列「${dst}」，该列将被忽略。`);
    }
  }
  return notes;
}

/** 解析结果：规范列 → 实际出现的源表头 */
export interface ResolvedMapping {
  /** 规范列 → 源表头 */
  byCanonical: Map<string, string>;
  /** 实际解析到的源列（用于 COLUMN_DRIFT） */
  parsedColumns: string[];
  /** 命中失败的规范列（源文件里没有） */
  missing: string[];
  notes: string[];
}

/**
 * 依据映射把源表头解析成「规范列 → 源表头」。
 * 同时返回 `parsedColumns`（规范列视角），供 DQ 的列漂移规则比对。
 */
export function resolveMapping(mapping: ColumnMapping, headers: readonly string[]): ResolvedMapping {
  const headerSet = new Set(headers);
  const byCanonical = new Map<string, string>();
  const notes: string[] = [];

  for (const [src, dst] of Object.entries(mapping.columns)) {
    if (headerSet.has(src) && !byCanonical.has(dst)) byCanonical.set(dst, src);
  }

  const missing = CANONICAL_COLUMNS.filter((c) => !byCanonical.has(c));

  // 源文件里有、但映射没覆盖、也不在忽略名单里的列 → 交给 COLUMN_DRIFT 报 block
  const ignored = new Set(mapping.ignore ?? []);
  const mappedSources = new Set([
    ...Object.keys(mapping.columns),
    ...mapping.dateColumns,
    ...ignored,
  ]);
  const unknown = headers.filter((h) => h !== '' && !mappedSources.has(h));
  if (unknown.length) {
    notes.push(`发现未映射的源列：${unknown.join('、')}。平台改版后请更新列映射配置。`);
  }

  const parsedCanonical: string[] = [...CANONICAL_COLUMNS].filter((c) => !missing.includes(c));
  return {
    byCanonical,
    // 规范列视角 + 未识别的源列（后者交由 COLUMN_DRIFT 报 block）
    parsedColumns: [...parsedCanonical, ...unknown],
    missing,
    notes,
  };
}
