/**
 * L5 · compute/costs —— 把日流水拆成税务申报口径的费用科目（PRD F1 / F3）
 *
 * 为什么必须落在内核：
 *   财务页要的「进项抵扣分档」（物料 13% / 物流 9% / 推广 6%）需要一套
 *   **各科目的含税金额**。若在页面里各自拼一遍，同样的成本在驾驶舱与财务页
 *   就会算出两个不同的税 —— 与 V9 的"三轨成本口径"是同一类事故。
 *
 * 口径与诚实度：
 *   · 物料：优先用 SkuMaster.unitCost × 销量（真实 BOM）；没有 SKU 维度数据时
 *     退化为「综合单瓶成本 × 销量」，并在 assumptions 中标注为估算；
 *   · 物流：按「一单一瓶」近似（源表没有订单数），同样标注；
 *   · 佣金 / 手续费：按各平台扣点率逐行计算，不用一个笼统的平均值；
 *   · 达人服务费 / 无票支出：尚无数据源，恒为 0，由 assumptions 明确告知。
 */

import type { CostPolicy } from '../model/finance.ts';
import type { DailyRecord, Platform } from '../model/daily.ts';
import { round2 } from '../model/daily.ts';
import type { SkuDaily, SkuMaster } from '../model/sku.ts';
import { cogsUnitCost } from '../model/sku.ts';
import type { CostBreakdown } from '../tax/types.ts';
import type { PeriodWindow } from './aggregate.ts';
import { aggregate } from './aggregate.ts';

export interface CostBreakdownInput {
  daily: readonly DailyRecord[];
  window: PeriodWindow;
  skuMaster: readonly SkuMaster[];
  costPolicy: CostPolicy;
  /** 可选的 SKU×日 明细；提供时物料成本取真实 BOM 而不是综合估算 */
  skuDaily?: readonly SkuDaily[];
}

export interface DerivedCosts extends Required<Omit<CostBreakdown, 'nonDeductible'>> {
  nonDeductible: number;
  /**
   * 口径可信度：
   *   'exact'      物料与物流来自真实 BOM / 真实订单数
   *   'estimated'  至少一项依赖近似（综合单瓶成本、一单一瓶…），界面必须打角标
   */
  quality: 'exact' | 'estimated';
  /** 人话假设清单（C7：界面必须逐条展示） */
  assumptions: string[];
}

/**
 * 派生各费用科目（**含税**金额 —— 价税分离由 tax 模块按各科目抵扣率处理）。
 *
 * 刻意不在这里做价税分离：那是 tax 的职责，两件事混在一起就会出现
 * "到底是按含税还是不含税算佣金"的口径漂移。
 */
export function deriveCosts(input: CostBreakdownInput): DerivedCosts {
  const { daily, window, skuMaster, costPolicy, skuDaily } = input;
  const rows = daily.filter((r) => r.date >= window.start && r.date <= window.end);

  let commission = 0;
  let paymentFee = 0;
  let promotion = 0;
  let dailyQty = 0;
  for (const r of rows) {
    const rate = costPolicy.platformCommissionRate[r.platform as Platform] ?? 0;
    commission += r.revenue * rate;
    paymentFee += r.revenue * costPolicy.paymentFeeRate;
    promotion += r.promotion;
    dailyQty += r.qty;
  }

  const hasSku = (skuDaily?.length ?? 0) > 0;
  let material = 0;
  let units = dailyQty;
  const assumptions: string[] = [];

  if (hasSku) {
    // 损益表口径：COGS（不含试香卡）。采购口径请用 m.unitCost。
    const costOf = new Map<string, number>();
    for (const m of skuMaster) costOf.set(m.sku, cogsUnitCost(m));
    material = 0;
    units = 0;
    for (const r of skuDaily ?? []) {
      if (r.date < window.start || r.date > window.end) continue;
      material += (costOf.get(r.sku) ?? 0) * r.qty;
      units += r.qty;
    }
  } else {
    // 无 SKU 明细：只能用综合单瓶成本 × 总销量，并如实标注为估算
    const agg = aggregate(daily, window, skuMaster);
    material = agg.materialCost;
    assumptions.push(
      '物料成本 = 综合单瓶成本（按预估月销加权）× 销量，属估算值；导入「商品×日」后将切换为真实 BOM。',
    );
  }

  // 物流按件数折算 —— 刻意与物料取**同一个**件数口径，
  // 否则"物料用 SKU 明细的销量、物流用日流水销量"会在两份数据不一致时各说各话。
  const logistics = units * costPolicy.logisticsPerOrder;
  assumptions.push('物流费按「一单一瓶」近似折算（源表没有订单数维度）。');

  if (!costPolicy.fillingPerUnit) assumptions.push('灌装成本尚未取数，未计入。');
  if (!costPolicy.laborPerUnit) assumptions.push('人工成本尚未取数，未计入。');
  if (!costPolicy.packagingLossRate) assumptions.push('包材损耗率尚未取数，未计入。');
  assumptions.push('达人/主播服务费与无票支出尚无数据源，按 0 参与计算。');

  return {
    material: round2(material),
    logistics: round2(logistics),
    promotion: round2(promotion),
    anchorService: 0,
    commission: round2(commission),
    paymentFee: round2(paymentFee),
    nonDeductible: 0,
    quality: hasSku ? 'exact' : 'estimated',
    assumptions,
  };
}

/** 转成 tax 模块需要的 CostBreakdown（丢弃元数据） */
export function toCostBreakdown(c: DerivedCosts): CostBreakdown {
  return {
    material: c.material,
    logistics: c.logistics,
    promotion: c.promotion,
    anchorService: c.anchorService,
    commission: c.commission,
    paymentFee: c.paymentFee,
    nonDeductible: c.nonDeductible,
  };
}
