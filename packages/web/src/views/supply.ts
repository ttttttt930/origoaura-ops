/**
 * L6 · views/supply —— 供应链与库存
 *
 * 三个数据可信度层次，界面必须分清楚：
 *   1. 有 SKU×日 销量 + 有库存主数据 → 给出覆盖天数与补货建议；
 *   2. 有库存主数据但没销量 → **unknown**，明确说"无法判断"，不给假健康度；
 *   3. 连库存主数据都没有 → 空态 + 填写指引。
 *
 * 供应商与采购金额一律从 SkuMaster.bom 派生 —— V9 读 `components[].unit_price`
 * 导致"供应商数恒为 0"，V10 只有一份结构。
 */

import {
  bomQuality,
  purchaseAmount,
  supplierSummary,
  type InventoryCoverage,
  type InventoryItem,
} from '@origo/core';
import type { ViewContext } from '../state.ts';
import { h, card, sectionHead, table, notes, tag, emptyState, collapsible, money, num } from '../ui/dom.ts';
import { barList, donut } from '../ui/charts.ts';
import { days } from '../ui/format.ts';
import { coverage } from './shared.ts';

const STATUS_LABEL: Record<InventoryCoverage['status'], string> = {
  stockout: '断货',
  urgent: '告急',
  watch: '待观察',
  healthy: '健康',
  overstock: '积压',
  unknown: '未知',
};

const STATUS_TAG: Record<InventoryCoverage['status'], 'est' | 'alloc' | 'ok' | 'off'> = {
  stockout: 'est',
  urgent: 'est',
  watch: 'alloc',
  healthy: 'ok',
  overstock: 'alloc',
  unknown: 'off',
};

export function renderSupply(ctx: ViewContext): Node {
  const { state } = ctx;
  const s = state.snapshot;
  const cov = coverage(state);
  const items = s.inventory;
  const unitCostOf = (sku: string): number =>
    s.skuMaster.find((m) => m.sku === sku)?.unitCost ?? 0;

  return h(
    'div',
    {},
    // ---------- 库存 ----------
    sectionHead('库存覆盖与补货建议', items ? `盘点日 ${items[0]?.asOf ?? '—'}` : '缺少库存主数据'),
    !items || !items.length
      ? emptyState(
          '尚无库存主数据',
          'data/master/inventory.json 为空。没有「现有库存 / 在途 / 提前期」就无法判断覆盖天数，本页不臆造这些数字。',
          [
            '在 data/master/inventory.json 里为每个 SKU 补一行：onHand / inTransit / leadTimeDays / safetyDays / moq',
            '维护成日常动作：每次盘点后更新 onHand 与 asOf',
            '运行 `npm run origo -- build` 重新生成快照，本页自动填充',
          ],
          '📦',
        )
      : renderInventory(items, cov ?? []),

    // ---------- 供应商 ----------
    h(
      'section',
      { class: 'section' },
      sectionHead('供应商集中度', '由 SkuMaster.bom 派生，唯一结构'),
      card(
        h(
          'div',
          { class: 'grid grid--2' },
          h(
            'div',
            {},
            donut(
              supplierSummary(s.skuMaster).map((s2) => ({
                label: s2.supplier,
                value: s2.componentCount,
              })),
              { centerLabel: String(supplierSummary(s.skuMaster).length), unit: '家供应商' },
            ),
          ),
          h(
            'div',
            {},
            table(
              null,
              ['供应商', '组件数', '覆盖 SKU', '组件均价'],
              supplierSummary(s.skuMaster).map((s2) => [
                s2.supplier,
                num(s2.componentCount),
                num(s2.skuCount),
                money(s2.avgUnitPrice),
              ]),
            ),
          ),
        ),
        h(
          'p',
          { class: 'card__note' },
          (() => {
            const q = bomQuality(s.skuMaster);
            return h('span', {}, q.allVerified ? tag('BOM 全部可追溯', 'ok') : tag('含占位结构 · 结构示意', 'est'), ` ${q.note}`);
          })(),
        ),
      ),
    ),

    // ---------- BOM ----------
    h(
      'section',
      { class: 'section' },
      sectionHead('BOM 成本结构', '单位成本为 OA 报价核定值（含包装）'),
      h(
        'div',
        { class: 'grid grid--2' },
        ...s.skuMaster.map((m) =>
          card(
            h(
              'div',
              { class: 'card__head' },
              h('p', { class: 'card__title' }, `${m.sku} · ${m.productLine}`),
              h('span', { class: 'dim' }, `单位成本 ${money(m.unitCost)}`),
            ),
            barList(
              m.bom.map((b) => ({
                label: b.name,
                value: b.unitPrice * b.qty,
                display: money(b.unitPrice * b.qty),
                note: b.isSample ? h('small', {}, ' 试香') : null,
              })),
            ),
            h(
              'p',
              { class: 'card__note' },
              m.bomSource === 'placeholder'
                ? '该 BOM 明细为占位结构（按经验占比拆分），逐组件核价不可用；单位成本本身是实采值。'
                : 'BOM 明细来自实采报价 / 采购单，可逐条追溯。',
            ),
          ),
        ),
      ),
    ),

    // ---------- 采购试算 ----------
    h(
      'section',
      { class: 'section' },
      sectionHead('补货金额试算', '按 BOM 单位成本 × 建议补货量'),
      card(
        cov && cov.length
          ? (() => {
              const lines = cov.filter((c) => c.suggestedQty > 0).map((c) => ({ sku: c.sku, qty: c.suggestedQty }));
              const amount = purchaseAmount(lines, s.skuMaster);
              return h(
                'div',
                {},
                lines.length
                  ? h(
                      'div',
                      {},
                      h('div', { class: 'hero__value' }, h('span', { class: 'hero__num' }, money(amount, 0))),
                      h('p', { class: 'hero__sub' }, `${lines.length} 款需补货，合计 ${num(lines.reduce((a, l) => a + l.qty, 0))} 瓶`),
                      table(
                        null,
                        ['SKU', '建议补货（瓶）', '单位成本', '金额'],
                        lines.map((l) => [
                          l.sku,
                          num(l.qty),
                          money(unitCostOf(l.sku)),
                          money(unitCostOf(l.sku) * l.qty),
                        ]),
                      ),
                    )
                  : h('p', { class: 'card__note' }, '按当前参数没有需要补货的 SKU。'),
              );
            })()
          : h('p', { class: 'card__note' }, '需要先有库存主数据与单品销量，才能给出补货建议。'),
      ),
    ),

    notes([
      '日均销量取近 30 天实测；无任何销量数据时返回 null 而不是 0，避免算出一个"看起来健康"的假覆盖天数。',
      '补货建议已按最小起订量（MOQ）向上取整。',
      '采购金额只认 SkuMaster.unitCost —— V9 读 `min_price` 导致金额恒为空，此处已杜绝双结构。',
    ]),
  );
}

function renderInventory(items: readonly InventoryItem[], cov: readonly InventoryCoverage[]): HTMLElement {
  const rows = cov.map((c) => [
    h('span', { class: 'strong' }, c.sku),
    num(c.onHand),
    num(c.inTransit),
    c.avgDailySales === null ? h('span', { class: 'dim' }, '—') : num(c.avgDailySales),
    days(c.coverDays),
    c.reorderPoint === null ? '—' : num(c.reorderPoint),
    c.suggestedQty > 0 ? h('span', { class: 'strong' }, num(c.suggestedQty)) : h('span', { class: 'dim' }, '0'),
    tag(STATUS_LABEL[c.status], STATUS_TAG[c.status]),
    h('span', { class: 'dim' }, c.message),
  ]);

  const unknown = cov.filter((c) => c.status === 'unknown');

  return h(
    'div',
    {},
    card(
      table(
        null,
        ['SKU', '现有', '在途', '日均销', '可售天数', '补货点', '建议补货', '状态', '结论'],
        rows,
      ),
    ),
    unknown.length
      ? h(
          'div',
          { style: { marginTop: '12px' } },
          emptyState(
            `${unknown.length} 款 SKU 无法判断库存健康度`,
            '这些 SKU 在近 30 天里没有任何单品销量数据。日均销量算不出来，覆盖天数就无从谈起 —— 这里不给 0，因为 0 会让"库存 0 瓶"看起来像"卖不动"而不是"没数据"。',
            [
              '导出各平台「商品 × 日」的支付件数（生意参谋 / 电商罗盘）',
              '放到 data/raw/ 后运行 `npm run origo -- ingest <文件> --kind sku`',
              '重新 `npm run origo -- build`，本页将自动给出覆盖天数与补货建议',
            ],
            '🧾',
          ),
        )
      : null,
    collapsible('查看库存主数据原始配置（提前期 / 安全天数 / MOQ）', h('pre', {}, JSON.stringify(items, null, 2))),
  );
}
