/**
 * 纳税人身份合规判定 —— 边界回归
 *
 * 这些用例直接对应 2026 年第 2 号公告的每一条规定，任何一条被改坏都会立刻红：
 *   阈值临界（恰好 / 超 1 元）、滚动窗口含空月、跨年、80% 预警、
 *   生效日 = 超标当期 1 日、自然人例外、已登记、逾期滞纳金、偶然销售剔除、
 *   窗口数据不足必须标注。
 */

import { describe, expect, it } from 'vitest';
import {
  isSmallScaleLegal,
  lateRegistrationPenalty,
  rollingSum,
  shiftMonth,
  taxpayerStatus,
  type MonthlySales,
} from '../src/tax/taxpayerStatus.ts';
import { taxParams } from './fixtures/dataset.ts';

const P = taxParams();

/** 造一段月度序列；缺省每月等额 */
function months(from: string, count: number, revenue: number): MonthlySales[] {
  const out: MonthlySales[] = [];
  let m = from;
  for (let i = 0; i < count; i++) {
    out.push({ month: m, revenue });
    m = shiftMonth(m, 1);
  }
  return out;
}

describe('月份推移（纯字符串算术，内核不用 Date）', () => {
  it('跨年与跨月边界', () => {
    expect(shiftMonth('2026-01', 1)).toBe('2026-02');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-03', 12)).toBe('2027-03');
  });
});

describe('500 万强制登记线 · 临界', () => {
  /** levyRate: 0 —— 让"恰好 500 万 / 超 1 元"的边界不含四舍五入噪声 */
  it('恰好等于阈值不触发强制登记（法条是「超过」才登记）', () => {
    const r = taxpayerStatus({
      monthly: [{ month: '2026-05', revenue: 5_000_000 }],
      levyRate: 0,
      params: P,
    });
    // 关键判据：没有超标点 → 不需要登记
    expect(r.crossing).toBeNull();
    expect(isSmallScaleLegal(5_000_000, P)).toBe(true);
    // 但已顶到线（100%），必须预警
    expect(r.warning).toBe(true);
  });

  it('超 1 元即触发强制登记', () => {
    const over = taxpayerStatus({
      monthly: [{ month: '2026-05', revenue: 5_000_001 }],
      levyRate: 0,
      params: P,
    });
    expect(over.status).toBe('must_register');
    expect(isSmallScaleLegal(5_000_001, P)).toBe(false);
  });

  it('明显低于阈值 → small_ok 且不预警', () => {
    const r = taxpayerStatus({
      monthly: [{ month: '2026-05', revenue: 3_000_000 }],
      levyRate: 0,
      params: P,
    });
    expect(r.status).toBe('small_ok');
    expect(r.warning).toBe(false);
  });

  it('生效日 = 超标当期 1 日；最迟办理 = 次月 15 日', () => {
    const r = taxpayerStatus({
      monthly: [{ month: '2026-11', revenue: 5_200_000 }],
      levyRate: 0,
      params: P,
    });
    expect(r.crossing?.month).toBe('2026-11');
    expect(r.crossing?.effectiveDate).toBe('2026-11-01');
    expect(r.crossing?.registerDeadline).toBe('2026-12-15');
  });
});

describe('滚动窗口（12 个月，含空月）', () => {
  it('空月不把窗口拉长：中间断档仍按 12 个自然月累计', () => {
    // 2026-01 ~ 2026-06 各 100 万，之后断档；2027-01 再来 100 万
    const seq: MonthlySales[] = [
      ...months('2026-01', 6, 1_000_000),
      { month: '2027-01', revenue: 1_000_000 },
    ];
    const r = taxpayerStatus({ monthly: seq, levyRate: 0, params: P });
    // 截至 2027-01 的回溯窗口 = 2026-02 ~ 2027-01：
    // 2026-02..06 各 100 万（500 万）+ 2027-01 的 100 万 = 600 万 > 500 万
    expect(r.status).toBe('must_register');
    // 关键是 2026-01 那 100 万**已被滚出窗口**（若按自然年累计会算成 700 万）
    expect(r.rolling12m).toBe(6_000_000);
  });

  it('跨年滚动：2025-12 ~ 2026-11', () => {
    const seq = months('2025-12', 12, 400_000); // 12 × 40 万 = 480 万 < 500 万
    const r = taxpayerStatus({ monthly: seq, levyRate: 0, params: P });
    expect(r.status).toBe('near_threshold'); // 480/500 = 96% ≥ 80%
    expect(r.warning).toBe(true);
    expect(r.rolling12m).toBe(4_800_000);
  });

  it('rollingSum 是**回溯**窗口：截至 end 月往前数，缺失月份补 0', () => {
    const seq: MonthlySales[] = [
      { month: '2026-01', revenue: 100 },
      { month: '2026-03', revenue: 200 }, // 2026-02 缺失
    ];
    // 截至 2026-03 的 3 个月 = 2026-01..03 → 100 + 0 + 200
    expect(rollingSum(seq, '2026-03', 3, 0)).toBe(300);
    // 截至 2026-02 的 3 个月 = 2025-12..2026-02 → 只有 2026-01
    expect(rollingSum(seq, '2026-02', 3, 0)).toBe(100);
    // 窗口只含缺失月 → 0
    expect(rollingSum(seq, '2026-02', 1, 0)).toBe(0);
    // 12 个月窗口同样只吃到有数据的月份
    expect(rollingSum(seq, '2026-03', 12, 0)).toBe(300);
  });

  it('方向不能反：截至 2027-01 不应把 2027 年之后的月份算进来', () => {
    const seq: MonthlySales[] = [
      { month: '2026-06', revenue: 1_000_000 },
      { month: '2027-06', revenue: 9_000_000 },
    ];
    // 回溯口径：截至 2026-06 的 12 个月只含自身 = 100 万（不是 1000 万）
    expect(rollingSum(seq, '2026-06', 12, 0)).toBe(1_000_000);
  });
});

describe('预警与状态', () => {
  it('达到阈值 80% 即预警但不强制', () => {
    const r = taxpayerStatus({
      monthly: [{ month: '2026-05', revenue: 4_000_000 }],
      levyRate: 0,
      params: P,
    });
    expect(r.status).toBe('near_threshold');
    expect(r.warning).toBe(true);
    expect(r.ratio).toBeCloseTo(0.8, 6);
    expect(r.headroom).toBe(1_000_000);
  });

  it('自然人例外：始终小规模，不做强制登记', () => {
    const r = taxpayerStatus({
      monthly: [{ month: '2026-05', revenue: 9_000_000 }],
      entityType: 'natural_person',
      levyRate: 0,
      params: P,
    });
    expect(r.status).toBe('exempt');
    expect(r.crossing).toBeNull();
  });

  it('已登记为一般纳税人：不再重复预警', () => {
    const r = taxpayerStatus({
      monthly: [{ month: '2026-05', revenue: 9_000_000 }],
      alreadyGeneral: true,
      levyRate: 0,
      params: P,
    });
    expect(r.status).toBe('general_registered');
    expect(r.warning).toBe(false);
  });

  it('逾期未登记 → general_overdue，并给出追溯生效日', () => {
    const r = taxpayerStatus({
      monthly: [{ month: '2026-11', revenue: 5_200_000 }],
      overdueDays: 30,
      levyRate: 0,
      params: P,
    });
    expect(r.status).toBe('general_overdue');
    expect(r.crossing?.effectiveDate).toBe('2026-11-01');
    expect(r.overdueDays).toBe(30);
  });
});

describe('滞纳金', () => {
  it('补税 10 万、逾期 30 天 → 10万 × 30 × 万分之五 = 1500', () => {
    expect(lateRegistrationPenalty(100_000, 30, P)).toBe(1_500);
  });
  it('负数与 0 天数一律不加收', () => {
    expect(lateRegistrationPenalty(-100, 30, P)).toBe(0);
    expect(lateRegistrationPenalty(100_000, 0, P)).toBe(0);
  });
});

describe('偶然销售剔除（2 号公告第三条）', () => {
  it('转让不动产不计入年应征增值税销售额', () => {
    const seq: MonthlySales[] = [{ month: '2026-05', revenue: 8_000_000 }];
    const before = taxpayerStatus({ monthly: seq, levyRate: 0, params: P });
    expect(before.status).toBe('must_register');

    const after = taxpayerStatus({
      monthly: seq,
      levyRate: 0,
      exemptSales: { '2026-05': 3_500_000 }, // 剔除 350 万后剩 450 万
      params: P,
    });
    expect(after.rolling12m).toBe(4_500_000);
    expect(after.status).toBe('near_threshold');
  });
});

describe('数据完整性（ADR-08）', () => {
  it('不足 12 个月时必须标注，不得假装是完整判定', () => {
    const r = taxpayerStatus({
      monthly: months('2026-01', 3, 10_000),
      levyRate: 0,
      params: P,
    });
    expect(r.monthsCovered).toBe(3);
    expect(r.insufficientWindow).toBe(true);
    expect(r.message).toContain('不完整窗口');
  });

  it('满 12 个月时不标注', () => {
    const r = taxpayerStatus({
      monthly: months('2026-01', 12, 10_000),
      levyRate: 0,
      params: P,
    });
    expect(r.insufficientWindow).toBe(false);
    expect(r.message).not.toContain('不完整窗口');
  });
});

describe('变异测试：判定必须真的读参数，不能是硬编码', () => {
  it('把阈值提到 1000 万，同一序列从 must_register 变合法', () => {
    const seq: MonthlySales[] = [{ month: '2026-05', revenue: 9_000_000 }];
    const before = taxpayerStatus({ monthly: seq, levyRate: 0, params: P });
    expect(before.status).toBe('must_register');

    // 阈值提到 1000 万 → 900 万变成"达线 90%"，仅预警不再强制
    const relaxed = taxpayerStatus({
      monthly: seq,
      levyRate: 0,
      params: { ...P, generalRegThreshold: 10_000_000 },
    });
    expect(relaxed.status).toBe('near_threshold');
    expect(relaxed.crossing).toBeNull();
  });

  it('把日费率改成万分之一，滞纳金应同比变化', () => {
    expect(lateRegistrationPenalty(100_000, 100, P)).toBe(5_000);
    expect(lateRegistrationPenalty(100_000, 100, { ...P, latePenaltyDailyRate: 0.0001 })).toBe(1_000);
  });
});
