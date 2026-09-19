/**
 * L5 · model/daily —— 店铺 × 日 规范化模型
 *
 * 设计约束：
 *  C1（SAD §1.2）31 个既有数据列名绝不改，完整保留在 DailyRecord.raw 供审计；
 *     界面文案可以改（DISP_NAMES），数据列名不行。
 *  C4（SAD §1.2）历史 1–6 月只有 4 平台、7 月起 5 平台；模型必须容忍列结构变化，
 *     故 normalize 后按「平台」拆成行，缺失平台直接不产出行，而非补 0。
 *
 * 本文件是纯类型 + 常量，无任何运行时副作用。
 */

/** 五个平台。顺序即展示顺序，新增平台只加在这里 + column-mappings。 */
export const PLATFORMS = ['taobao', 'douyin', 'xiaohongshu', 'tiktok', 'pdd'] as const;

export type Platform = (typeof PLATFORMS)[number];

/** 'YYYY-MM-DD' */
export type ISODate = string;
/** 'YYYY-MM' */
export type ISOMonth = string;

/**
 * C1 硬约束：这 31 个列名永不修改。
 * 与 V9 `daily_metrics` 表的列一一对应（除 date 外共 31 列）。
 */
export const CANONICAL_COLUMNS = [
  '总收入', '总支出', '总推广支出', '净收入', '总退款', '总销量',
  '淘宝收入', '淘宝退款', '淘宝推广支出', '淘宝净收入', '淘宝销量',
  '抖音收入', '抖音退款', '抖音推广支出', '抖音净收入', '抖音销量',
  '拼多多收入', '拼多多退款', '拼多多推广支出', '拼多多净收入', '拼多多销量',
  '小红书收入', '小红书退款', '小红书推广支出', '小红书净收入', '小红书销量',
  'tiktok收入', 'tiktok退款', 'tiktok推广支出', 'tiktok净收入', 'tiktok销量',
] as const;

export type CanonicalColumn = (typeof CANONICAL_COLUMNS)[number];

/** 平台 → 列名前缀（C1 列名的中文前缀映射） */
export const PLATFORM_LABEL: Record<Platform, string> = {
  taobao: '淘宝',
  douyin: '抖音',
  xiaohongshu: '小红书',
  tiktok: 'tiktok',
  pdd: '拼多多',
};

/** 各平台在本系统中的 5 个结果指标后缀（与 C1 列名保持一致） */
export const PLATFORM_METRICS = ['收入', '退款', '推广支出', '净收入', '销量'] as const;
export type PlatformMetric = (typeof PLATFORM_METRICS)[number];

/** 某平台在某日是否有列（C4：历史月份可能整块缺失） */
export function platformColumns(platform: Platform): Record<PlatformMetric, CanonicalColumn> {
  const p = PLATFORM_LABEL[platform];
  return {
    收入: `${p}收入` as CanonicalColumn,
    退款: `${p}退款` as CanonicalColumn,
    推广支出: `${p}推广支出` as CanonicalColumn,
    净收入: `${p}净收入` as CanonicalColumn,
    销量: `${p}销量` as CanonicalColumn,
  };
}

/**
 * 店铺 × 日的规范化记录。
 *
 * 注意 `net` 是**构建期重算**值，不信任原始表里的净收入公式
 * （7 月事故：漏退款列导致净收入虚高 ¥6,391，SAD §5.1）。
 */
export interface DailyRecord {
  date: ISODate;
  platform: Platform;
  /** 含税流水 GMV 口径（沿用现有） */
  revenue: number;
  refund: number;
  promotion: number;
  /** = revenue − refund − promotion，构建期重算，不读原公式 */
  net: number;
  /** 支付件数 */
  qty: number;
  /** 原始 31 列，审计用，列名永不改 */
  raw: Record<string, number | string>;
  /** 溯源：原始文件名 + 行号 */
  source: string;
}

/**
 * 店铺 × 日 的"总计行"（跨平台汇总），由 normalize 从各平台行合成。
 * 平台维度已拆开后，总计行只用于 DQ 勾稽比对，不参与业务计算。
 */
export interface TotalRecord {
  date: ISODate;
  revenue: number;
  refund: number;
  promotion: number;
  net: number;
  qty: number;
  /** 该日实际有数据的平台数量（C4：用于识别 4 平台期 / 5 平台期） */
  platformCount: number;
}

/**
 * 原始表里那一行「总计」列的申报值。
 * 关键：DQ 必须能比较「原表申报的总计」与「各平台相加」，否则规则恒真（无意义）。
 * 7 月事故正是二者不等却没被发现（漏了退款列）。
 */
export interface DeclaredTotals {
  revenue?: number;
  refund?: number;
  promotion?: number;
  /** 原表「总支出」= 推广 + 退款（口径见 CANONICAL_COLUMNS） */
  expense?: number;
  net?: number;
  qty?: number;
}

/** 从原始 31 列中读取申报总计（列不存在则为 undefined，不补 0） */
export function readDeclared(raw: Record<string, number | string>): DeclaredTotals {
  const num = (col: string): number | undefined => {
    const v = raw[col];
    // 列缺席与"列存在但为空"都要区分：缺席 → undefined（不参与勾稽）
    if (v === undefined || v === null || v === '') return undefined;
    const p = parseNumeric(v);
    return p.status === 'blank' ? undefined : p.value;
  };
  return {
    revenue: num('总收入'),
    refund: num('总退款'),
    promotion: num('总推广支出'),
    expense: num('总支出'),
    net: num('净收入'),
    qty: num('总销量'),
  };
}

/** 一天 = 各平台行 + 总计行的规范化"日"对象，DQ 规则的操作单位 */
export interface NormalizedDay {
  date: ISODate;
  /** 各平台行（缺失平台不出现） */
  platforms: DailyRecord[];
  /** 总计行；由各平台合计**推导**而来（单一事实源） */
  total: TotalRecord;
  /** 原表申报的总计值；用于 DQ 勾稽，缺失则为 undefined */
  declared?: DeclaredTotals;
}

/** 把规范化后的平台行按日归组为 NormalizedDay[]，日期升序 */
export function groupDays(records: readonly DailyRecord[]): NormalizedDay[] {
  const byDate = new Map<ISODate, DailyRecord[]>();
  for (const r of records) {
    const list = byDate.get(r.date);
    if (list) list.push(r);
    else byDate.set(r.date, [r]);
  }

  const days: NormalizedDay[] = [];
  for (const [date, platforms] of byDate) {
    platforms.sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform));
    // 总计行一律由平台行求和推导 —— 单一事实源，不读原表总计列
    const total: TotalRecord = {
      date,
      revenue: sum(platforms, (p) => p.revenue),
      refund: sum(platforms, (p) => p.refund),
      promotion: sum(platforms, (p) => p.promotion),
      net: 0,
      qty: sum(platforms, (p) => p.qty),
      platformCount: platforms.length,
    };
    total.net = round2(total.revenue - total.refund - total.promotion);
    // 申报总计取自原始行（各平台行携带同一份 raw），仅用于勾稽比对
    const raw = platforms[0]?.raw;
    days.push({ date, platforms, total, declared: raw ? readDeclared(raw) : undefined });
  }

  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return days;
}

/** 浮点两位取整（金额统一口径，SAD §4.1：金额以「元、浮点两位」存储） */
export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * 构造 DailyRecord —— **净收入的唯一算法出口**。
 *
 * 管道与前端都只能调这个函数，不得各自写 `revenue - refund - promotion`。
 * 这正是 7 月事故的防线：当年净收入是原表里的一列公式，各家算法还不一致。
 */
export function makeDailyRecord(input: {
  date: ISODate;
  platform: Platform;
  revenue: number;
  refund: number;
  promotion: number;
  qty: number;
  raw?: Record<string, number | string>;
  source?: string;
}): DailyRecord {
  const revenue = safeNumber(input.revenue);
  const refund = safeNumber(input.refund);
  const promotion = safeNumber(input.promotion);
  return {
    date: input.date,
    platform: input.platform,
    revenue,
    refund,
    promotion,
    net: round2(revenue - refund - promotion),
    qty: safeNumber(input.qty),
    raw: input.raw ?? {},
    source: input.source ?? '',
  };
}

/** 取数结果的成因，用于区分"格式问题"与"真正的异常值" */
export type NumericStatus =
  | 'ok'         // 本来就是数字
  | 'coerced'    // 是文本，但能无歧义地解析成数字（千分位、货币符号、全角逗号…）
  | 'blank'      // 空 / 占位符（-、—、N/A），按 0 处理
  | 'invalid';   // 无法解析，按 0 处理并需要人工核查

export interface NumericParse {
  value: number;
  status: NumericStatus;
  /** 原始文本（便于报告定位） */
  raw: string;
}

/**
 * 解析数值单元格。
 *
 * 为什么必须处理"文本型数字"：实测 2026-07 的日报里，淘宝收入被粘贴成了
 * 文本 `"1,291.44"`，`Number()` 直接返回 NaN。旧实现把它静默当 0，
 * 于是当日平台收入合计变成 ¥0、净收入凭空多出一千多元 ——
 * 一个字符的格式问题就能骗过整条链路。
 * 这里统一做**无歧义**的格式归一，并把成因如实返回，供 DQ 报 warn。
 *
 * 刻意不处理（有歧义，必须人工判断）：
 *   · 欧陆写法 `1.291,44`（点与逗号都出现且位置反常）
 *   · 带单位或说明的文本（如 `约1200`、`1200元/件`）
 */
export function parseNumeric(v: unknown): NumericParse {
  if (v === null || v === undefined) return { value: 0, status: 'blank', raw: '' };
  if (typeof v === 'number') {
    return Number.isFinite(v)
      ? { value: v, status: 'ok', raw: String(v) }
      : { value: 0, status: 'invalid', raw: String(v) };
  }
  if (typeof v === 'boolean' || typeof v === 'object') {
    return { value: 0, status: 'invalid', raw: String(v) };
  }

  const raw = String(v);
  const s = raw.replace(/[\s\u3000\u00a0]/g, '');
  if (!s || /^[-—–]+$/.test(s) || /^(n\/?a|null|nil|none|无|—)$/i.test(s)) {
    return { value: 0, status: 'blank', raw };
  }

  // 会计括号负数：(1,234.56) → -1234.56
  const paren = /^\((.*)\)$/.exec(s);
  const body = paren ? paren[1]! : s;

  // 百分号：在金额列里出现百分比格式，只有"零"是无歧义的（6月汇总的退款列就是 `0.00%`）。
  // 非零百分比（如 `12.5%`）到底是 12.5 还是 0.125，无法从单元格本身判定 → 交给人工核查。
  const percent = /^(.*)%$/.exec(body);
  if (percent) {
    const inner = Number(percent[1]!.replace(/[，,]/g, ''));
    if (Number.isFinite(inner) && inner === 0) {
      return { value: 0, status: 'coerced', raw };
    }
    return { value: 0, status: 'invalid', raw };
  }

  // 去掉货币符号与千分位（半角/全角逗号）
  const cleaned = body.replace(/[¥￥$£€]/g, '').replace(/[，,]/g, '');
  if (cleaned === '' || !/^-?\d*\.?\d*$/.test(cleaned) || cleaned === '-' || cleaned === '.') {
    return { value: 0, status: 'invalid', raw };
  }

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { value: 0, status: 'invalid', raw };

  const formatted = cleaned !== s || paren !== null;
  return { value: paren ? -n : n, status: formatted ? 'coerced' : 'ok', raw };
}

/**
 * 容错取数：非数值 / 空值一律记 0，避免 NaN 污染整条链路。
 * 需要知道"为什么是 0"（格式问题还是真异常）时请改用 parseNumeric。
 */
export function safeNumber(v: unknown): number {
  return parseNumeric(v).value;
}

function sum<T>(arr: readonly T[], pick: (t: T) => number): number {
  let acc = 0;
  for (const item of arr) acc += pick(item);
  return round2(acc);
}
