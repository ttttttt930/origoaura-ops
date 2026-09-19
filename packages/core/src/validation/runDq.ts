/**
 * L5 · validation/runDq —— 规则执行器（SAD §5.3 失败行为）
 *
 *  任一 block：管道退出非零、**不产出新快照**、输出定位报告（行号/字段/期望/实际/差异/建议）
 *  仅 warn  ：产出快照，但前端「质量中心」常驻黄色提示；warn 允许"已知差异备注"留痕
 */

import { DATASET_RULES, DAY_RULES, type DqContext } from './rules.ts';
import type { DqFinding, DqReport } from '../model/snapshot.ts';
import type { NormalizedDay } from '../model/daily.ts';

/**
 * 执行全部 DQ 规则。
 * @param days    规范化后的日数据
 * @param ctx     规则上下文（不含 days，由本函数注入，避免调用方传错）
 * @param ranAt   执行时间戳，由调用方注入（内核不取当前时间，保证可测）
 */
export function runDq(
  days: readonly NormalizedDay[],
  ctx: Omit<DqContext, 'days'>,
  ranAt: string,
): DqReport {
  const fullCtx: DqContext = { ...ctx, days };
  const findings: DqFinding[] = [];

  // ---- 逐日规则 ----
  for (const rule of DAY_RULES) {
    for (const day of days) {
      const hits = rule.check(day, fullCtx);
      if (!hits) continue;
      for (const h of hits) {
        findings.push(finalize(h, rule.id, rule.severity, rule.message(h), fullCtx));
      }
    }
  }

  // ---- 数据集规则 ----
  for (const rule of DATASET_RULES) {
    const hits = rule.check(fullCtx);
    if (!hits) continue;
    for (const h of hits) {
      findings.push(finalize(h, rule.id, rule.severity, rule.message(h), fullCtx));
    }
  }

  // 排序：block 优先，其次按 scope（定位友好）
  findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'block' ? -1 : 1;
    return a.scope.localeCompare(b.scope);
  });

  const blockCount = findings.filter((f) => f.severity === 'block').length;
  const warnCount = findings.length - blockCount;

  return {
    passed: blockCount === 0,
    ranAt,
    blockCount,
    warnCount,
    findings,
    rulesRun: DAY_RULES.length + DATASET_RULES.length,
  };
}

function finalize(
  h: Omit<DqFinding, 'ruleId' | 'severity' | 'message'>,
  ruleId: string,
  severity: DqFinding['severity'],
  message: string,
  ctx: DqContext,
): DqFinding {
  const ackKey = `${ruleId}|${h.scope}`;
  const acknowledged = ctx.acknowledged?.[ackKey];
  const finding: DqFinding = { ruleId, severity, message, ...h };
  if (acknowledged) finding.acknowledged = acknowledged;
  return finding;
}

/** 生成人话报告（CLI 红屏输出 / 前端质量中心共用） */
export function formatDqReport(report: DqReport): string {
  const lines: string[] = [];
  const status = report.passed ? '✅ 通过' : '❌ 未通过（block 存在，已阻止发布）';
  lines.push(`数据质量检查：${status}`);
  lines.push(`  规则执行 ${report.rulesRun} 条 · block ${report.blockCount} · warn ${report.warnCount}`);
  lines.push(`  执行时间 ${report.ranAt}`);
  if (!report.findings.length) {
    lines.push('  未发现任何问题。');
    return lines.join('\n');
  }
  for (const f of report.findings) {
    const tag = f.severity === 'block' ? '[BLOCK]' : '[WARN ]';
    lines.push(`  ${tag} ${f.ruleId} @ ${f.scope}`);
    lines.push(`          ${f.message}`);
    if (f.acknowledged) lines.push(`          备注（已留痕）：${f.acknowledged}`);
  }
  return lines.join('\n');
}

/** 按规则聚合，供前端质量中心画趋势/分布 */
export function summarizeByRule(report: DqReport): { ruleId: string; severity: string; count: number }[] {
  const m = new Map<string, { ruleId: string; severity: string; count: number }>();
  for (const f of report.findings) {
    const cur = m.get(f.ruleId);
    if (cur) cur.count += 1;
    else m.set(f.ruleId, { ruleId: f.ruleId, severity: f.severity, count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}
