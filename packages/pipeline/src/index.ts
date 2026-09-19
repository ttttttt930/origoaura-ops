/**
 * @origo/pipeline —— L4 数据管道（唯一允许 IO 的层）
 *
 * 依赖方向：pipeline → core（单向）。管道不得依赖 web（eslint 强制）。
 * 所有口径计算都调 @origo/core，本包只负责：读文件、适配、规范化、校验、加密、落盘。
 */

export * from './config/paths.ts';
export * from './config/key.ts';
export * from './config/loadMaster.ts';
export * from './adapters/xlsx.ts';
export * from './adapters/columnMapping.ts';
export * from './adapters/excelDaily.ts';
export * from './adapters/dailyMonthly.ts';
export * from './adapters/platformSku.ts';
export * from './store/canonical.ts';
export * from './snapshot/build.ts';
export * from './snapshot/encrypt.ts';
export * from './snapshot/manifest.ts';
export * from './snapshot/publish.ts';
