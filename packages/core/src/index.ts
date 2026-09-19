/**
 * @origo/core —— L5 领域内核（单一事实源）
 *
 * 硬性纪律（SAD §1.3 / §2.1，由 eslint.config.js 自动把关）：
 *   · 本包**纯 TypeScript**，零 IO、零 DOM、零网络、零时间随机；
 *   · 本包**不依赖**任何其他包（web / pipeline 都依赖它，它谁也不依赖）；
 *   · 所有业务口径只在这里定义一次，界面与管道都只能调用，不得各算一份。
 *
 * 目录：
 *   model/       数据结构与常量（31 列口径、SKU、成本、税务参数、快照信封）
 *   validation/  数据质量规则与执行器（管道强制闸门）
 *   compute/     聚合、分摊、单品毛利、渠道、库存、预警
 *   tax/         增值税 → 附加税 → 印花税 → 所得税 → 分红 全链路
 *   forecast/    跑率外推
 */

export * from './model/index.ts';
export * from './validation/index.ts';
export * from './compute/index.ts';
export * from './tax/index.ts';
export * from './forecast/index.ts';
