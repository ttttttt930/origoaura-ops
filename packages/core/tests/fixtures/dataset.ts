/**
 * 测试夹具（合成数据，不来自真实业务文件）
 *
 * 为什么不读真实 rows.json / scenarios.json：
 *   SAD 提到过这两个金币（golden）资产，但它们并未随架构文档落地；
 *   与其等待，不如用**可复现的合成夹具**覆盖同样的事故场景：
 *     · julyIncident —— 复刻 7 月「净收入漏减退款、多计 ¥6,391」
 *     · september    —— 正常的 5 平台 10 天
 *
 * 数据形状刻意对齐真实 Excel：**一行一天、31 列**（含各平台列 + 总计列）。
 * 内核把它炸成"平台行"，但每一行都携带同一份 raw，供 DQ 勾稽。
 */

import type {
  CostPolicy,
  DailyRecord,
  Platform,
  SkuDaily,
  SkuMaster,
  TaxParams,
} from '../../src/index.ts';
import { CANONICAL_COLUMNS, PLATFORM_LABEL, PLATFORMS } from '../../src/index.ts';

/** 某平台在某天的四个基础量 */
export type PlatformCell = [revenue: number, refund: number, promotion: number, qty: number];

export interface BuildDayOptions {
  /** 覆盖申报的总计列（用于复刻"公式被改坏"的历史事故） */
  declaredPatch?: Partial<Record<string, number>>;
  /** 从 raw 中**删除**的列（复刻"列漏配"，如 7 月漏退款列） */
  omitDeclared?: string[];
  /** 溯源文件名 */
  source?: string;
}

/**
 * 构造一天的原始行 —— 返回该日各平台各一条 DailyRecord，raw 完全一致。
 * 若省略 declaredPatch，则申报总计 = 各平台合计（即"健康数据"）。
 */
export function buildDay(
  date: string,
  platforms: Partial<Record<Platform, PlatformCell>>,
  opts: BuildDayOptions = {},
): DailyRecord[] {
  const entries = PLATFORMS.filter((p) => platforms[p] !== undefined).map(
    (p) => [p, platforms[p] as PlatformCell] as const,
  );

  const sum = (i: number) => entries.reduce((a, [, c]) => a + c[i], 0);
  const raw: Record<string, number | string> = {
    总收入: sum(0),
    总退款: sum(1),
    总推广支出: sum(2),
    总销量: sum(3),
    总支出: sum(1) + sum(2),
    净收入: sum(0) - sum(1) - sum(2),
  };

  for (const [p, c] of entries) {
    const label = PLATFORM_LABEL[p];
    raw[`${label}收入`] = c[0];
    raw[`${label}退款`] = c[1];
    raw[`${label}推广支出`] = c[2];
    raw[`${label}净收入`] = c[0] - c[1] - c[2];
    raw[`${label}销量`] = c[3];
  }

  for (const [k, v] of Object.entries(opts.declaredPatch ?? {})) raw[k] = v as number;
  for (const k of opts.omitDeclared ?? []) delete raw[k];

  // 仅仅作为审计留痕：raw 里不应出现 31 列之外的东西
  const source = opts.source ?? 'fixture.xlsx#2';

  return entries.map(([p, c]) => ({
    date,
    platform: p,
    revenue: c[0],
    refund: c[1],
    promotion: c[2],
    net: c[0] - c[1] - c[2],
    qty: c[3],
    raw: { ...raw },
    source,
  }));
}

/** 每个平台的日基准量，用来生成稳定的时间序列 */
const BASE: Record<Platform, PlatformCell> = {
  taobao: [8000, 600, 1800, 48],
  douyin: [12000, 900, 3200, 64],
  xiaohongshu: [2500, 180, 700, 14],
  tiktok: [1800, 120, 500, 8],
  pdd: [900, 70, 200, 6],
};

const scaled = (c: PlatformCell, k: number): PlatformCell => [
  Math.round(c[0] * k),
  Math.round(c[1] * k),
  Math.round(c[2] * k),
  Math.round(c[3] * k),
];

/** 2026-09-01 ~ 09-10，5 平台，申报口径自洽（应通过全部 block 规则） */
export function septemberRecords(): DailyRecord[] {
  const out: DailyRecord[] = [];
  for (let d = 1; d <= 10; d += 1) {
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    const k = 1 + (d % 3) * 0.05;
    const day: Partial<Record<Platform, PlatformCell>> = {};
    for (const p of PLATFORMS) day[p] = scaled(BASE[p], k);
    out.push(...buildDay(date, day));
  }
  return out;
}

/**
 * 7 月事故日：淘宝退款 ¥6,391 只存在于平台列，却没有进入原表的「总支出 / 净收入」，
 * 且「总退款」列整列缺失（对应"列漏配"）。
 * 期望：DQ 同时命中 EXPENSE_EQUALS_PARTS 与 NET_EQUALS_REV_MINUS_EXP。
 */
export function julyIncidentRecords(): DailyRecord[] {
  return buildDay(
    '2026-07-15',
    { taobao: [50_000, 6_391, 3_000, 300], douyin: [30_000, 0, 2_000, 180] },
    {
      declaredPatch: {
        总收入: 80_000,
        总推广支出: 5_000,
        总支出: 5_000, // ← 漏了退款 6,391
        净收入: 75_000, // ← 虚高 6,391
        总销量: 480,
      },
      omitDeclared: ['总退款'],
      source: '营销发展日报-202607.xlsx#15',
    },
  );
}

/** 复制一份日期，用于构造多日常规序列 */
export function shiftDay(records: readonly DailyRecord[], fromDate: string, toDate: string): DailyRecord[] {
  return records
    .filter((r) => r.date === fromDate)
    .map((r) => ({ ...r, date: toDate, raw: { ...r.raw } }));
}

/**
 * SKU 主数据夹具 —— **必须与 data/master/sku-bom.json 同源同值**（7 款）。
 *
 * 历史教训：V9→V10 迁移时夹具与主数据同时漂移到「5 款 + 拍脑袋成本」，
 * 于是 111 个测试全绿，却没一个发现成本口径错了 —— 测试在给错误数据背书。
 * 现在夹具逐字段对齐真实主数据，并由 skuMasterIntegrity.test.ts 在**本地**
 * 直接读真实文件做交叉校验（该文件含供应商报价，不入库，故 CI 上跳过）。
 */
export function skuMaster(): SkuMaster[] {
  /** 小样单价：不计入 COGS */
  const SAMPLE_PRICE = 0.32;

  const mk = (
    sku: string,
    spec: string,
    unitCost: number,
    defaultPrice: number,
    estMonthlyQty: number,
    productLine: string,
  ): SkuMaster => {
    // 与主数据一样保留 4 位小数：加权前先舍到 2 位会把 ¥14.59 压成 ¥14.58
    const unitCostCogs = round4(unitCost - SAMPLE_PRICE);
    // 按「不在场50ml」的真实结构占比拆分，差额并入包装盒，保证 BOM 求和 == unitCost
    const weights = [0.5523, 0.0964, 0.0438, 0.0039, 0.0208, 0.228, 0.0548];
    const vals = weights.map((w) => round4(unitCostCogs * w));
    const drift = round4(unitCostCogs - vals.reduce((a, b) => a + b, 0));
    vals[5] = round4(vals[5] + drift); // 差额并入「天地盖包装盒」

    return {
      sku,
      spec,
      productLine,
      unitCost,
      unitCostCogs,
      defaultPrice,
      status: 'active',
      estMonthlyQty,
      costBasis: 'supplier-quote-2026-09',
      bomSource: 'verified',
      bom: [
        { name: '香水水体', qty: 1, unitPrice: vals[0], supplier: '葵花' },
        { name: '蔚蓝方形菱角瓶50ml', qty: 1, unitPrice: vals[1], supplier: '润园' },
        { name: '黑色电解铝喷头+吸管', qty: 1, unitPrice: vals[2], supplier: '葵花' },
        { name: '透明pvc底标', qty: 1, unitPrice: vals[3], supplier: '葵花' },
        { name: 'pvc标贴', qty: 1, unitPrice: vals[4], supplier: '竣彩' },
        { name: '天地盖包装盒', qty: 1, unitPrice: vals[5], supplier: '嘉华' },
        // 两瓶一袋，故 qty=0.5：unitPrice 要还原成整袋价
        { name: 'OrigoAura TF礼品袋', qty: 0.5, unitPrice: round4(vals[6] * 2), supplier: '墨艺' },
        { name: '试香卡版本2', qty: 1, unitPrice: SAMPLE_PRICE, supplier: '新丽光', isSample: true },
      ],
    };
  };

  return [
    mk('不在场50ml', '50ml', 11.7265, 198, 200, 'Bleu Absent'),
    mk('晚点到50ml', '50ml', 14.9545, 168, 150, 'Sneaky Link'),
    mk('含苞50ml', '50ml', 11.6895, 168, 150, 'Bloom'),
    mk('绽放50ml', '50ml', 11.6895, 198, 250, 'Bloom'),
    mk('暗戳戳100ml', '100ml', 23.4045, 268, 300, 'Sneaky Link'),
    mk('西西里白橘50ml', '50ml', 10.9895, 188, 80, '限定'),
    mk('放过菲格夫人50ml', '50ml', 10.8895, 188, 80, '限定'),
  ];
}

/**
 * 真实主数据的标杆值 —— 由 scripts/sync-sku-master.mjs 从供应商报价表导出。
 * 加权口径（按预估月销）：全口径 ¥14.91 / COGS 口径 ¥14.59，总月销 1210 瓶。
 */
export const SKU_MASTER_BASELINE = {
  skuCount: 7,
  totalEstMonthlyQty: 1210,
  weightedUnitCost: 14.91,
  weightedUnitCostCogs: 14.59,
} as const;

/** SKU × 平台 × 日（09-01 ~ 09-10，仅淘宝与抖音有数据） */
export function skuDailyRecords(): SkuDaily[] {
  const out: SkuDaily[] = [];
  const mix: { sku: string; price: number; taobaoQty: number; douyinQty: number }[] = [
    { sku: '不在场50ml', price: 198, taobaoQty: 6, douyinQty: 9 },
    // 真实规格是 100ml（V10 曾误写成 50ml，导致 SKU 映射不上、毛利与分摊同时失真）
    { sku: '暗戳戳100ml', price: 268, taobaoQty: 4, douyinQty: 7 },
    { sku: '西西里白橘50ml', price: 168, taobaoQty: 3, douyinQty: 2 },
  ];
  for (let d = 1; d <= 10; d += 1) {
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    for (const m of mix) {
      out.push({
        date,
        platform: 'taobao',
        sku: m.sku,
        qty: m.taobaoQty,
        avgPrice: m.price,
        refundQty: 0,
        refundAmount: 0,
      });
      out.push({
        date,
        platform: 'douyin',
        sku: m.sku,
        qty: m.douyinQty,
        avgPrice: m.price,
        refundQty: 0,
        refundAmount: 0,
      });
    }
  }
  return out;
}

/** 所有 31 个规范列都解析到了（供 DQ 的 COLUMN_DRIFT 使用） */
export function allColumns(): string[] {
  return [...CANONICAL_COLUMNS];
}

/** 成本口径（平台扣点 / 支付费率 / 物流单价已取真值，灌装人工留空） */
export function costPolicy(): CostPolicy {
  return {
    platformCommissionRate: {
      taobao: 0.05,
      douyin: 0.05,
      xiaohongshu: 0.05,
      tiktok: 0.05,
      pdd: 0.006,
    },
    paymentFeeRate: 0.006,
    logisticsPerOrder: 5.5,
    fillingPerUnit: 0,
    laborPerUnit: 0,
    packagingLossRate: 0,
    note: '平台扣点/支付费率/物流单价为 2026-09 实测值；灌装、人工、包材损耗未取数。',
  };
}

/** 税务参数（2026 现行有效） */
export function taxParams(): TaxParams {
  return {
    policyValidUntil: '2027-12-31',
    vatGeneralRate: 0.13,
    vatSmallRateNominal: 0.03,
    vatSmallRateActual: 0.01,
    smallExemptMonthly: 100_000,
    smallExemptQuarterly: 300_000,
    inputRateMaterial: 0.13,
    inputRateLogistics: 0.09,
    inputRatePromotion: 0.06,
    inputRateAnchor: 0.06,
    surtaxCityRate: 0.07,
    surtaxEduRate: 0.03,
    surtaxLocalEduRate: 0.02,
    surtaxHalved: true,
    stampDutyRate: 0.0003,
    stampDutyHalved: true,
    citSmallMicroRate: 0.05,
    citStatutoryRate: 0.25,
    citSmallMicroThreshold: 3_000_000,
    dividendTaxRate: 0.2,
    generalRegThreshold: 5_000_000,
    thresholdWarnRatio: 0.8,
    latePenaltyDailyRate: 0.0005,
  };
}

/** 4 位小数：BOM 单价（如 0.0445）本身就是四位精度，加权前不得先舍到 2 位 */
function round4(v: number): number {
  return Math.round((v + Number.EPSILON) * 10000) / 10000;
}

/** 固定基准日，保证测试可复现 */
export const TODAY = '2026-09-10';
