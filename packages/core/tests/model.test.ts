import { describe, expect, it } from 'vitest';
import {
  CANONICAL_COLUMNS,
  PLATFORMS,
  compareSemver,
  groupDays,
  migrateToCurrent,
  parseSemver,
  platformColumns,
  purchaseAmount,
  readDeclared,
  round2,
  snapshotFileName,
  supplierSummary,
} from '../src/index.ts';
import { septemberRecords, skuMaster, SKU_MASTER_BASELINE } from './fixtures/dataset.ts';

describe('C1 列名契约', () => {
  it('恰好 31 列，且 5 个平台 × 5 指标 + 6 个总计列', () => {
    expect(CANONICAL_COLUMNS).toHaveLength(31);
    expect(new Set(CANONICAL_COLUMNS).size).toBe(31);
    const platformCols = PLATFORMS.flatMap((p) => Object.values(platformColumns(p)));
    expect(platformCols).toHaveLength(25);
    for (const c of platformCols) expect(CANONICAL_COLUMNS).toContain(c);
  });
});

describe('groupDays —— 总计行由平台推导（单一事实源）', () => {
  it('平台行求和，忽略原表申报值', () => {
    const [day] = groupDays(septemberRecords());
    expect(day).toBeDefined();
    const d = day!;
    expect(d.platforms).toHaveLength(5);
    expect(d.total.platformCount).toBe(5);
    expect(d.total.revenue).toBeCloseTo(
      d.platforms.reduce((a, p) => a + p.revenue, 0),
      2,
    );
    expect(d.total.net).toBeCloseTo(d.total.revenue - d.total.refund - d.total.promotion, 2);
  });

  it('申报总计被单独保留，供 DQ 勾稽（不被覆盖）', () => {
    const [day] = groupDays(septemberRecords());
    const declared = day!.declared;
    expect(declared?.revenue).toBeCloseTo(day!.total.revenue, 2);
  });

  it('readDeclared 对缺失列返回 undefined 而非 0', () => {
    const d = readDeclared({ 总收入: '100', 总支出: '' });
    expect(d.revenue).toBe(100);
    expect(d.expense).toBeUndefined();
    expect(d.refund).toBeUndefined();
  });

  it('日期升序且按平台固定顺序排列', () => {
    const days = groupDays(septemberRecords());
    expect(days.map((d) => d.date)).toEqual([...days.map((d) => d.date)].sort());
    expect(days[0]!.platforms.map((p) => p.platform)).toEqual([...PLATFORMS]);
  });
});

describe('round2', () => {
  it('避免浮点尾差', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-0.004)).toBe(-0);
  });
});

describe('快照版本协商', () => {
  it('parseSemver / compareSemver', () => {
    expect(parseSemver('10.2.3')).toEqual({ major: 10, minor: 2, patch: 3 });
    expect(parseSemver('v10')).toBeNull();
    expect(compareSemver('10.1.0', '10.0.9')).toBeGreaterThan(0);
    expect(compareSemver('9.9.9', '10.0.0')).toBeLessThan(0);
    expect(compareSemver('10.0.0', '10.0.0')).toBe(0);
  });

  it('同版本直接通过；缺迁移函数则报可读错误', () => {
    expect(migrateToCurrent({ schemaVersion: '10.0.0' })).toEqual({ schemaVersion: '10.0.0' });
  });

  it('前端版本低于快照版本时明确拒绝', () => {
    expect(() => migrateToCurrent({ schemaVersion: '11.0.0' }, '10.0.0')).toThrow(/高于前端支持版本/);
  });

  it('快照文件名不可变时间戳', () => {
    expect(snapshotFileName('2026-09-10T21:04:33.123Z')).toBe('marketing-data.202609102104.js');
  });
});

describe('供应商聚合 —— 修复 V9「供应商数恒为 0」', () => {
  it('从唯一的 SkuMaster.bom 派生，而不是读不存在的字段', () => {
    const rows = supplierSummary(skuMaster());
    const names = rows.map((r) => r.supplier);
    // 真实供应商（2026-09 报价表）：葵花 / 润园 / 竣彩 / 嘉华 / 墨艺 / 新丽光
    expect(names).toContain('葵花');
    expect(names).toContain('新丽光');
    expect(rows.every((r) => r.componentCount >= 1 && r.skuCount >= 1)).toBe(true);
    // 新丽光只供「试香卡版本2」，但覆盖全部 7 款 SKU
    const xl = rows.find((r) => r.supplier === '新丽光');
    expect(xl?.componentCount).toBe(1);
    expect(xl?.skuCount).toBe(SKU_MASTER_BASELINE.skuCount);
  });

  it('采购金额按 unitCost（全口径）× qty —— 采购要真付试香卡的钱', () => {
    const master = skuMaster();
    const bleu = master.find((s) => s.sku === '不在场50ml')!;
    const sneak = master.find((s) => s.sku === '暗戳戳100ml')!;
    const amount = purchaseAmount(
      [
        { sku: '不在场50ml', qty: 100 },
        { sku: '暗戳戳100ml', qty: 50 },
      ],
      master,
    );
    // purchaseAmount 内部舍到分，故用 1 位小数容差
    expect(amount).toBeCloseTo(bleu.unitCost * 100 + sneak.unitCost * 50, 1);
    // 采购口径必须比 COGS 口径贵（差在小样）
    expect(amount).toBeGreaterThan(bleu.unitCostCogs! * 100 + sneak.unitCostCogs! * 50);
  });
});
