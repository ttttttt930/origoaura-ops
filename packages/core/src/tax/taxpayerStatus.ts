/**
 * L5 · tax/taxpayerStatus —— 纳税人身份合规判定（ADR-13）
 *
 * 为什么必须是架构级能力，而不是页面上的一行提示：
 *   "小规模还是一般"**不是可选项**。连续不超过 12 个月（或 4 个季度）经营期内
 *   累计应征增值税销售额（不含税）超过 500 万元，有限公司必须在**超标次月申报期内**
 *   登记为一般纳税人，生效日追溯到**超标当期 1 日**；逾期会被强制按一般纳税人管理，
 *   并追溯补税 + 按日万分之五滞纳金，且追溯期内以小规模身份取得的普票不能抵进项。
 *   把两种身份并列成"哪个省税就选哪个"的测算，会直接把人引向违法申报。
 *
 * 法条依据（2026-09 现行有效）：
 *   ·《中华人民共和国增值税法》第九条：小规模纳税人 = 年应征增值税销售额未超过 500 万元
 *   ·《国家税务总局关于增值税一般纳税人登记管理有关事项的公告》（2026 年第 2 号）
 *      一、超标须登记（仅自然人 / 特定非企业单位例外）
 *      三、年应征增值税销售额 = 连续不超过 12 个月或 4 个季度经营期内累计；
 *          经营期含未取得销售收入的月份或季度；
 *          偶然销售无形资产、转让不动产的销售额不计入
 *      五、常规超标 → 超标次月申报纳税期限内办理；
 *          自查/稽查调整导致超标 → 调整之日起 10 个工作日内
 *      六、生效之日 = 超过标准的当期 1 日（2025 年四季度/12 月超标者不早于 2026-01-01）
 *
 * 内核纪律：纯函数、零 IO / 零 DOM、零 `new Date()` —— 月份推移全部用字符串算术，
 *          保证 Node（管道）与浏览器（WebCrypto 侧渲染）逐字节一致。
 */

import type { TaxParams } from '../model/finance.ts';
import type { ISOMonth } from '../model/daily.ts';

/** 'YYYY-MM' → { y, m } */
function parseMonth(m: ISOMonth): { y: number; m: number } {
  const [y, mo] = m.split('-');
  return { y: Number(y), m: Number(mo) };
}

function fmtMonth(y: number, m: number): ISOMonth {
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** 月份推移（支持负数）。纯字符串算术，不碰 Date。 */
export function shiftMonth(month: ISOMonth, delta: number): ISOMonth {
  const { y, m } = parseMonth(month);
  const total = y * 12 + (m - 1) + delta;
  return fmtMonth(Math.floor(total / 12), (total % 12) + 1);
}

/** 该月 1 日 */
export function monthStart(month: ISOMonth): string {
  return `${month}-01`;
}

export interface MonthlySales {
  /** 'YYYY-MM' */
  month: ISOMonth;
  /** 该月**含税**销售额（GMV 口径） */
  revenue: number;
}

/**
 * 主体类型。
 * - company / sole_proprietorship：有限公司、个体户等经营主体，适用 500 万强制登记
 * - natural_person：自然人，按小规模纳税，不登记（2 号公告第一类例外）
 * - non_enterprise_inactive：不经常发生应税交易且主营业务非应税的非企业单位，可选小规模
 */
export type EntityType = 'company' | 'sole_proprietorship' | 'natural_person' | 'non_enterprise_inactive';

export type TaxpayerStatusKind =
  | 'small_ok' // 未达标的合法小规模
  | 'near_threshold' // 已达预警比例，未超标
  | 'must_register' // 已超标，须在次月申报期内登记
  | 'general_overdue' // 已超标且逾期未登记
  | 'general_registered' // 已登记为一般纳税人
  | 'exempt'; // 法定例外，可继续小规模

export interface CrossingPoint {
  /** 使滚动 12 个月累计首次超过阈值的月份 */
  month: ISOMonth;
  /** 截至该月的滚动 12 个月不含税累计 */
  rolling12m: number;
  /** 一般纳税人生效日 = 超标当期 1 日 */
  effectiveDate: string;
  /** 最迟办理日（次月申报期，按 15 日估算；申报期顺延以主管税务机关公告为准） */
  registerDeadline: string;
}

export interface TaxpayerStatusResult {
  status: TaxpayerStatusKind;
  /** 截至最后一个有数据月份的滚动 12 个月不含税累计 */
  rolling12m: number;
  /** 距强制登记线的余量（负数表示已超标） */
  headroom: number;
  /** rolling12m / threshold */
  ratio: number;
  /** 是否触发预警（≥ thresholdWarnRatio） */
  warning: boolean;
  crossing: CrossingPoint | null;
  /**
   * 数据完整性：窗口内**有数据**的月份数。
   * 不足 12 个月时判定基于不完整窗口，界面必须标注，不得假装是完整判定（ADR-08）。
   */
  monthsCovered: number;
  insufficientWindow: boolean;
  overdueDays: number;
  latePenaltyDailyRate: number;
  message: string;
}

export interface TaxpayerStatusInput {
  monthly: readonly MonthlySales[];
  entityType?: EntityType;
  /** 已登记为一般纳税人 */
  alreadyGeneral?: boolean;
  /** 逾期天数（用于 general_overdue 与滞纳金估算） */
  overdueDays?: number;
  /** 偶然销售无形资产 / 转让不动产，按月份剔除（2 号公告第三条） */
  exemptSales?: Readonly<Record<ISOMonth, number>>;
  /** 含税 → 不含税的换算率；不传则按小规模 1% 征收率反算 */
  levyRate?: number;
  params: TaxParams;
  /** 滚动窗口月数，默认 12（按季申报可传 12；4 季度口径同样为 12 个月） */
  windowMonths?: number;
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/** 含税 → 不含税 */
function toExclusive(revenue: number, levyRate: number): number {
  return revenue / (1 + levyRate);
}

/**
 * **截至 end 月（含）**的回溯 windowMonths 个月不含税累计。
 *
 * 方向很关键：法条的"连续不超过 12 个月经营期内累计"是**截至当月的过去 12 个月**，
 * 不是从当月往后数 12 个月。税务总局官方举例也是回溯口径
 * （"截至 2026 年 11 月累计 = 前三季度 400 万 + 10 月 20 万 + 11 月 100 万 = 520 万"）。
 * 方向搞反会把"超标时点"整体提前 11 个月，直接导致错误登记与错误补税。
 *
 * **缺失的月份按 0 计入**（2 号公告：经营期含未取得销售收入的月份）——
 * 这正是"滚动窗口"与自然年累计的关键差别，空月不能把窗口拉长。
 */
export function rollingSum(
  monthly: readonly MonthlySales[],
  end: ISOMonth,
  windowMonths: number,
  levyRate: number,
  exempt?: Readonly<Record<ISOMonth, number>>,
): number {
  const map = new Map<ISOMonth, number>();
  for (const m of monthly) {
    const ex = toExclusive(m.revenue, levyRate) - (exempt?.[m.month] ?? 0);
    map.set(m.month, (map.get(m.month) ?? 0) + Math.max(0, ex));
  }
  let sum = 0;
  let cur = shiftMonth(end, -(windowMonths - 1));
  for (let i = 0; i < windowMonths; i++) {
    sum += map.get(cur) ?? 0;
    cur = shiftMonth(cur, 1);
  }
  return sum;
}

/** 找出使滚动窗口累计首次**超过**阈值的月份（严格大于；恰好等于 500 万仍属小规模） */
function findCrossing(
  monthly: readonly MonthlySales[],
  threshold: number,
  windowMonths: number,
  levyRate: number,
  exempt?: Readonly<Record<ISOMonth, number>>,
): CrossingPoint | null {
  const months = [...new Set(monthly.map((m) => m.month))].sort();
  for (const m of months) {
    const total = rollingSum(monthly, m, windowMonths, levyRate, exempt);
    if (total > threshold) {
      const nextMonth = shiftMonth(m, 1);
      return {
        month: m,
        rolling12m: round2(total),
        effectiveDate: monthStart(m),
        registerDeadline: `${nextMonth}-15`,
      };
    }
  }
  return null;
}

export function taxpayerStatus(input: TaxpayerStatusInput): TaxpayerStatusResult {
  const T = input.params;
  const threshold = T.generalRegThreshold;
  const warnAt = threshold * T.thresholdWarnRatio;
  const windowMonths = input.windowMonths ?? 12;
  const levyRate = input.levyRate ?? T.vatSmallRateActual;
  const overdueDays = Math.max(0, input.overdueDays ?? 0);
  const entity = input.entityType ?? 'company';

  const months = [...new Set(input.monthly.map((m) => m.month))].sort();
  const last = months[months.length - 1];
  const rolling = last ? rollingSum(input.monthly, last, windowMonths, levyRate, input.exemptSales) : 0;
  const monthsCovered = months.length;
  const insufficientWindow = monthsCovered < windowMonths;
  const gapNote = insufficientWindow
    ? `（窗口内仅 ${monthsCovered}/${windowMonths} 个月有数据，判定基于不完整窗口）`
    : '';

  const base = {
    rolling12m: round2(rolling),
    headroom: round2(threshold - rolling),
    ratio: threshold > 0 ? rolling / threshold : 0,
    monthsCovered,
    insufficientWindow,
    overdueDays,
    latePenaltyDailyRate: T.latePenaltyDailyRate,
  };

  // 法定例外：自然人 / 特定非企业单位可继续按小规模纳税
  if (entity === 'natural_person' || entity === 'non_enterprise_inactive') {
    return {
      ...base,
      status: 'exempt',
      warning: rolling >= warnAt,
      crossing: null,
      message:
        entity === 'natural_person'
          ? '自然人属于小规模纳税人，不办理一般纳税人登记（增值税法实施条例）。'
          : '不经常发生应税交易且主要业务不属于应税交易范围的非企业单位，可选择按小规模纳税人纳税。',
    };
  }

  if (input.alreadyGeneral) {
    return {
      ...base,
      status: 'general_registered',
      warning: false,
      crossing: findCrossing(input.monthly, threshold, windowMonths, levyRate, input.exemptSales),
      message: '已登记为一般纳税人，按「销项 − 进项」一般计税。',
    };
  }

  const crossing = findCrossing(input.monthly, threshold, windowMonths, levyRate, input.exemptSales);

  let status: TaxpayerStatusKind;
  let message: string;
  if (crossing) {
    if (overdueDays > 0) {
      status = 'general_overdue';
      message =
        `已于 ${crossing.month} 超标（滚动 ${windowMonths} 个月不含税销售额 ` +
        `¥${crossing.rolling12m.toLocaleString('zh-CN')} > 阈值），逾期未登记：将被强制按一般纳税人管理，` +
        `生效日追溯至 ${crossing.effectiveDate}，追溯补税并按日万分之五加收滞纳金，` +
        `且追溯期内以小规模身份取得的普通发票不得抵扣进项。${gapNote}`;
    } else {
      status = 'must_register';
      message =
        `已于 ${crossing.month} 超标，应在**次月申报期内**（不晚于 ${crossing.registerDeadline}）` +
        `办理一般纳税人登记，生效日为 ${crossing.effectiveDate}。` +
        `逾期将被强制认定并追溯补税。${gapNote}`;
    }
  } else if (rolling >= warnAt) {
    status = 'near_threshold';
    message =
      `滚动 ${windowMonths} 个月不含税销售额已达强制登记线的 ` +
      `${((rolling / threshold) * 100).toFixed(1)}%（¥${round2(rolling).toLocaleString('zh-CN')}），` +
      `请提前规范取得进项专用发票并准备登记材料。${gapNote}`;
  } else {
    status = 'small_ok';
    message =
      `滚动 ${windowMonths} 个月不含税销售额 ¥${round2(rolling).toLocaleString('zh-CN')}，` +
      `低于强制登记线，小规模身份合法。${gapNote}`;
  }

  return { ...base, status, warning: rolling >= warnAt, crossing, message };
}

/**
 * 逾期登记的滞纳金估算：需补增值税额 × 逾期天数 × 日费率。
 * 注意这只是滞纳金，**不含**追溯补税本金与进项断层损失，界面不得把它当成全部代价。
 */
export function lateRegistrationPenalty(
  underpaidVat: number,
  overdueDays: number,
  params: TaxParams,
): number {
  return round2(Math.max(0, underpaidVat) * Math.max(0, overdueDays) * params.latePenaltyDailyRate);
}

/** 由"年化不含税销售额"快速判断小规模身份是否合法（≤ 阈值即合法） */
export function isSmallScaleLegal(annualSalesEx: number, params: TaxParams): boolean {
  return annualSalesEx <= params.generalRegThreshold;
}
