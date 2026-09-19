/**
 * 单元格格式回归 —— 直接来自 2026-07 的真实事故
 *
 * 现象：7月汇总的淘宝「当日收入/当日退款/当日销量」23 天是**文本型**单元格，
 *      且金额带千分位（`"1,291.44"`）。外部解析器把它当成无法解析 → 置 0，
 *      于是 7/2、7/4–7/7、7/10、7/13–7/20 共 15 天的平台收入凭空少计 ¥20,673.09
 *      （销量列没有千分位，所以销量对得上、收入对不上 —— 这个不对称正是破案线索）。
 *
 * 内核纪律：文本数字必须被**解析并标记为 coerced**，由 CELL_FORMAT 规则报 warn，
 *          绝不允许静默置 0。
 */

import { describe, expect, it } from 'vitest';
import { makeDailyRecord, parseNumeric, safeNumber } from '../src/model/daily.ts';

describe('文本型单元格解析', () => {
  it('带千分位的金额文本必须解析出真实值，并标记为 coerced', () => {
    const p = parseNumeric('1,291.44');
    expect(p.value).toBe(1291.44);
    expect(p.status).toBe('coerced');
    expect(p.raw).toBe('1,291.44');
  });

  it('全角逗号、货币符号、全角空格同样要解析', () => {
    expect(parseNumeric('２，０５３．１９').value).toBe(0); // 全角数字不在支持范围 → 记为 invalid 而非静默 0
    expect(parseNumeric('２，０５３．１９').status).toBe('invalid');
    expect(safeNumber('¥2,053.19')).toBe(2053.19);
    expect(safeNumber(' 1,077.44 ')).toBe(1077.44);
  });

  it('会计括号负数与百分比零值', () => {
    expect(safeNumber('(1,234.56)')).toBe(-1234.56);
    expect(parseNumeric('0.00%').status).toBe('coerced');
    expect(parseNumeric('12.5%').status).toBe('invalid'); // 非零百分比有歧义 → 交人工，不猜
  });

  it('彻底解析不了必须标 invalid，绝不静默置 0', () => {
    const p = parseNumeric('待补录');
    expect(p.status).toBe('invalid');
    expect(p.value).toBe(0);
  });

  /** 直接复刻 7/2 那一行：淘宝收入是文本 "1,291.44" */
  it('makeDailyRecord 对文本千分位单元格得到正确净收入', () => {
    const r = makeDailyRecord({
      date: '2026-07-02',
      platform: 'taobao',
      revenue: '1,291.44' as unknown as number,
      refund: '206.10' as unknown as number,
      promotion: 594.64,
      qty: '11' as unknown as number,
    });
    expect(r.revenue).toBe(1291.44);
    expect(r.refund).toBe(206.1);
    expect(r.qty).toBe(11);
    // 净收入一律重算，不读原表公式
    expect(r.net).toBe(490.7);
  });
});
