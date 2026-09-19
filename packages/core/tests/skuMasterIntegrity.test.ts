/**
 * SKU 主数据完整性 —— 直接读真实 data/master/sku-bom.json 做交叉校验
 *
 * 为什么有这个测试：
 *   夹具（fixtures/dataset.ts）是人抄的，抄错了测试一样全绿。V9→V10 那次漂移就是
 *   夹具和主数据同时错成「5 款 + 拍脑袋成本」，111 个测试没有一个报警。
 *   所以这里**不抄、直接读真实文件**，把夹具钉死在现实上。
 *
 * 为什么 CI 上会跳过：
 *   sku-bom.json 含供应商报价与单位成本（商业敏感，已 gitignore），不能入库。
 *   因此 CI 无法校验；本地与发布前必须跑 —— 发布脚本里已强制前置该校验。
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blendedPurchaseUnitCost, blendedUnitCost } from '../src/index.ts';
import type { SkuMaster } from '../src/index.ts';
import { skuMaster, SKU_MASTER_BASELINE } from './fixtures/dataset.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MASTER = resolve(ROOT, 'data/master/sku-bom.json');
const HAS_MASTER = existsSync(MASTER);

function readMaster(): { items: SkuMaster[]; meta: Record<string, unknown> } | null {
  if (!HAS_MASTER) return null;
  const raw = JSON.parse(readFileSync(MASTER, 'utf8')) as {
    items?: SkuMaster[];
    [k: string]: unknown;
  };
  return { items: raw.items ?? [], meta: raw };
}

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

describe('SKU 主数据完整性（读真实 data/master/sku-bom.json）', () => {
  it.skipIf(!HAS_MASTER)('夹具与真实主数据逐字段一致（7 款 / 规格 / 售价 / 成本 / 月销）', () => {
    const m = readMaster();
    if (!m) return;
    expect(m.items.length).toBe(SKU_MASTER_BASELINE.skuCount);

    const real = new Map(m.items.map((i) => [String(i.sku), i]));
    const fixture = skuMaster();
    expect(fixture.length).toBe(m.items.length);

    for (const f of fixture) {
      const r = real.get(f.sku);
      expect(r, `主数据里缺少 SKU「${f.sku}」`).toBeTruthy();
      if (!r) continue;
      expect(r.spec, `${f.sku} 规格漂移`).toBe(f.spec);
      expect(r.defaultPrice, `${f.sku} 售价漂移`).toBeCloseTo(f.defaultPrice ?? 0, 2);
      expect(r.estMonthlyQty, `${f.sku} 预估月销漂移`).toBe(f.estMonthlyQty);
      expect(r.unitCost, `${f.sku} 全口径成本漂移`).toBeCloseTo(f.unitCost, 2);
      expect(r.unitCostCogs ?? r.unitCost, `${f.sku} COGS 成本漂移`).toBeCloseTo(
        f.unitCostCogs ?? f.unitCost,
        2,
      );
    }
  });

  it.skipIf(!HAS_MASTER)('每款 SKU 的 BOM 求和 == unitCost（明细不得与总额各说各话）', () => {
    const m = readMaster();
    if (!m) return;
    for (const i of m.items) {
      const sum = round2((i.bom ?? []).reduce((a, b) => a + b.unitPrice * b.qty, 0));
      expect(sum, `${i.sku} 的 BOM 明细合计 ${sum} ≠ unitCost ${i.unitCost}`).toBeCloseTo(i.unitCost, 1);
    }
  });

  it.skipIf(!HAS_MASTER)('unitCost − unitCostCogs 恰好等于小样成本（试香卡随瓶发出）', () => {
    const m = readMaster();
    if (!m) return;
    const samplePrice = 0.32;
    for (const i of m.items) {
      const samples = (i.bom ?? []).filter((b) => b.isSample).reduce((a, b) => a + b.unitPrice * b.qty, 0);
      expect(round2(i.unitCost - (i.unitCostCogs ?? i.unitCost)), `${i.sku} 小样口径不符`).toBeCloseTo(
        round2(samples || samplePrice),
        2,
      );
    }
  });

  it.skipIf(!HAS_MASTER)('综合单瓶成本落在标杆值上（COGS ¥14.59 / 全口径 ¥14.91）', () => {
    const m = readMaster();
    if (!m) return;
    expect(blendedUnitCost(m.items).value).toBeCloseTo(SKU_MASTER_BASELINE.weightedUnitCostCogs, 2);
    expect(blendedPurchaseUnitCost(m.items)).toBeCloseTo(SKU_MASTER_BASELINE.weightedUnitCost, 2);
    expect(m.items.reduce((a, i) => a + (i.estMonthlyQty ?? 0), 0)).toBe(
      SKU_MASTER_BASELINE.totalEstMonthlyQty,
    );
  });

  it.skipIf(!HAS_MASTER)('bomSource 为 verified，且每个 BOM 行都取到了真实报价', () => {
    const m = readMaster();
    if (!m) return;
    expect(m.meta.bomSource).toBe('verified');
    for (const i of m.items) {
      expect(i.bomSource, `${i.sku} 口径降级为 placeholder`).toBe('verified');
      for (const b of i.bom ?? []) {
        expect(b.priced, `${i.sku} 的组件「${b.name}」没取到报价`).toBe(true);
        expect(b.supplier, `${i.sku} 的组件「${b.name}」缺供应商`).toBeTruthy();
      }
    }
  });

  it('夹具自身的 BOM 求和自洽（不依赖真实文件，CI 也跑）', () => {
    for (const f of skuMaster()) {
      const sum = round2(f.bom.reduce((a, b) => a + b.unitPrice * b.qty, 0));
      expect(sum, `夹具 ${f.sku} 的 BOM 合计不自洽`).toBeCloseTo(f.unitCost, 1);
    }
    expect(blendedUnitCost(skuMaster()).value).toBeCloseTo(SKU_MASTER_BASELINE.weightedUnitCostCogs, 2);
  });

  it('未挂载主数据时给出明确信号，而不是静默通过', () => {
    if (!HAS_MASTER) {
      console.warn(
        '⚠ data/master/sku-bom.json 不存在 —— 主数据交叉校验已跳过。' +
          '该文件含供应商报价不入库；本地与发布前请确认已由 sync-sku-master.mjs 生成。',
      );
    }
    expect(typeof HAS_MASTER).toBe('boolean');
  });
});
