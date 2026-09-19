/**
 * L6 · views/quality —— 数据质量中心
 *
 * 定位：本看板的"可信度证据链"。三个用途：
 *   1. 出问题时先来这里 —— 是数据错了，还是口径错了？
 *   2. 让"闸门拦下了什么"可见（SAD §5.3：宁可没有新数据，也不让错数据进链）；
 *   3. 展示指纹与版本协商结果，证明"你看到的这份数据就是管道产出的那份"。
 */

import {
  ALL_RULE_IDS,
  summarizeByRule,
  type DqFinding,
  type DqReport,
  type Snapshot,
} from '@origo/core';
import type { ViewContext } from '../state.ts';
import { h, card, sectionHead, table, notes, tag, kv, collapsible, badge } from '../ui/dom.ts';
import { money } from '../ui/format.ts';

const RULE_NAME: Record<string, string> = {
  EXPENSE_EQUALS_PARTS: '总支出 = 退款 + 推广',
  NET_EQUALS_REV_MINUS_EXP: '净收入 = 营收 − 总支出',
  PLATFORM_SUM_EQUALS_TOTAL: '各平台合计 = 总计',
  NONNEG_QTY: '销量非负',
  REFUND_LE_REVENUE: '退款 ≤ 营收',
  PRICE_IN_RANGE: '客单价在合理区间',
  DATE_CONTINUITY: '日期连续无断档',
  NO_DUP_DATE: '日期不重复',
  COLUMN_DRIFT: '列结构未漂移',
  SKU_UNMAPPED: 'SKU 已映射',
  CELL_FORMAT: '单元格格式可解析',
};

export function renderQuality(ctx: ViewContext): Node {
  const { state } = ctx;
  const s = state.snapshot;
  const dq: DqReport = s.dqReport;
  const byRule = summarizeByRule(dq);

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'grid grid--3' },
      card(
        h('p', { class: 'card__title' }, '闸门结论'),
        h(
          'div',
          { class: 'hero__value' },
          h('span', { class: 'hero__num' }, dq.passed ? '通过' : '拦截'),
        ),
        h(
          'p',
          { class: 'hero__sub' },
          dq.passed
            ? '本次构建无 block，快照已下发。'
            : `有 ${dq.blockCount} 条 block —— 按设计已阻止生成快照，线上仍是上一版。`,
        ),
        h(
          'div',
          { class: 'chips-inline', style: { marginTop: '8px' } },
          dq.passed ? tag('可发布', 'ok') : tag('拒绝发布', 'est'),
          tag(`${dq.warnCount} warn`, dq.warnCount ? 'est' : 'ok'),
        ),
      ),
      card(
        h('p', { class: 'card__title' }, '规则覆盖'),
        h('div', { class: 'hero__value' }, h('span', { class: 'hero__num' }, `${dq.rulesRun} / ${ALL_RULE_IDS.length}`)),
        h('p', { class: 'hero__sub' }, `本次执行 ${dq.rulesRun} 条，注册表共 ${ALL_RULE_IDS.length} 条。`),
        h('p', { class: 'card__note' }, '规则注册表是唯一的规则来源，新增规则只需在内核注册一处。'),
      ),
      card(
        h('p', { class: 'card__title' }, '跨端指纹一致性'),
        h(
          'div',
          { class: 'hero__value' },
          h('span', { class: 'hero__num' }, `${state.load.checksumResults.filter((c) => c.ok).length} / ${state.load.checksumResults.length}`),
        ),
        h('p', { class: 'hero__sub' }, '浏览器用 WebCrypto 重算，与管道 Node 侧结果逐字节比对。'),
        h(
          'div',
          { class: 'chips-inline', style: { marginTop: '8px' } },
          state.load.allChecksumsOk ? tag('全部一致', 'ok') : tag('发现不一致', 'est'),
        ),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('校验和明细', '键排序序列化 → SHA-256'),
      card(
        table(
          null,
          ['分区', '管道产出（前 16 位）', '浏览器重算（前 16 位）', '结论'],
          state.load.checksumResults.map((c) => [
            h('span', { class: 'strong' }, c.key),
            h('span', { class: 'mono' }, c.expected.slice(0, 16) || '—'),
            h('span', { class: 'mono' }, c.actual.slice(0, 16)),
            c.ok ? tag('一致', 'ok') : tag('不一致', 'est'),
          ]),
        ),
        h('p', { class: 'card__note' }, '两边都用内核的 stableStringify（键排序）后再哈希，所以 Node 与浏览器得到同一个值 —— 这是"跨端口径一致"的可验证证据，不是一句口号。'),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('规则执行结果', byRule.length ? `命中 ${byRule.length} 类` : '全部通过'),
      card(
        byRule.length
          ? table(
              null,
              ['规则', '名称', '命中条数', '严重度'],
              byRule.map((r) => [
                h('span', { class: 'mono' }, r.ruleId),
                RULE_NAME[r.ruleId] ?? '—',
                String(r.count),
                r.severity === 'block' ? tag('block', 'est') : tag('warn', 'alloc'),
              ]),
            )
          : h('p', { class: 'card__note' }, `${dq.rulesRun} 条规则全部通过，没有命中任何问题。`),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('问题明细', '差异 = 实际 − 期望'),
      card(
        dq.findings.length
          ? table(
              null,
              ['严重度', '规则', '定位', '期望', '实际', '差异', '说明'],
              dq.findings.map((f: DqFinding) => [
                f.severity === 'block' ? tag('block', 'est') : tag('warn', 'alloc'),
                h('span', { class: 'mono' }, f.ruleId),
                h('span', { class: 'mono' }, f.scope),
                money(f.expected),
                money(f.actual),
                h('span', { class: f.diff === 0 ? 'dim' : 'down' }, money(f.diff)),
                h('span', {}, f.message, f.acknowledged ? h('div', { class: 'dim' }, `留痕：${f.acknowledged}`) : null),
              ]),
            )
          : h('p', { class: 'card__note' }, '没有需要展示的问题。'),
        h('p', { class: 'card__note' }, '已知差异可在 data/master/dq-acknowledged.json 留痕。**留痕只是记录原因，不豁免 block** —— 带 block 的数据仍然不会产出快照（SAD §5.3）。'),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('全部规则清单', `共 ${ALL_RULE_IDS.length} 条`),
      card(
        table(
          null,
          ['#', '规则 ID', '中文名', '本次是否命中'],
          ALL_RULE_IDS.map((id, i) => [
            String(i + 1),
            h('span', { class: 'mono' }, id),
            RULE_NAME[id] ?? '—',
            byRule.some((r) => r.ruleId === id)
              ? tag(`命中 ${byRule.find((r) => r.ruleId === id)?.count}`, 'est')
              : tag('未命中', 'ok'),
          ]),
        ),
      ),
    ),

    h(
      'section',
      { class: 'section' },
      sectionHead('快照元信息'),
      card(
        kv([
          ['schemaVersion', s.schemaVersion],
          ['前端支持版本', state.load.frontendSchemaVersion],
          ['来源版本', state.load.sourceSchemaVersion],
          ['是否发生迁移', state.load.migrated ? '是' : '否'],
          ['生成时间', s.generatedAt],
          ['数据区间', `${s.period.start} ~ ${s.period.end}`],
          ['日报行数', String(s.daily.length)],
          ['SKU×日 行数', String(s.skuDaily.length)],
          ['SKU 主数据', `${s.skuMaster.length} 款`],
          ['管道版本', s.pipelineVersion ?? '—'],
        ]),
        h(
          'div',
          { class: 'badges', style: { marginTop: '12px' } },
          badge('加密：AES-256-GCM / PBKDF2-SHA256 × 150,000', 'info'),
          badge('ADR-06：加密仅防明文抓取，不构成权限隔离', 'warn'),
        ),
        collapsible('查看快照结构（不含 daily 明细）', h('pre', {}, JSON.stringify(structureOf(s), null, 2))),
      ),
    ),

    notes([
      'DQ 闸门在**构建期**执行，不通过就不产出快照 —— 这是 7 月那 ¥6,391 事故的直接防线。',
      '「期望 vs 实际」比较的是「源表申报的总计」与「各平台行重算的合计」，两边独立计算，规则才不会恒真。',
      '若本页出现「未命中」之外的 block，请不要手工改快照 —— 回到源表修数据后重跑 `npm run origo -- ingest && origo build`。',
    ]),
  );
}

/** 只保留结构骨架，避免把 150 行日流水塞进 <pre> */
function structureOf(s: Snapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'daily') out.daily = `DailyRecord[${(v as unknown[]).length}]`;
    else if (k === 'skuDaily') out.skuDaily = `SkuDaily[${(v as unknown[]).length}]`;
    else if (k === 'skuMaster') out.skuMaster = (v as unknown[]).map((x) => (x as { sku: string }).sku);
    else out[k] = v;
  }
  return out;
}
