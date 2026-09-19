// ESLint 9 flat config —— 强制 V10 架构的依赖方向（SAD §13 风险应对）
//
//   L6 web  ──import──▶  L5 core          （允许）
//   L4 pipeline ─import──▶  L5 core        （允许）
//   L5 core  ──import──▶  web / pipeline   （禁止：内核不得反向依赖）
//   L4 pipeline ─import──▶  web            （禁止：管道不得依赖表现层）
//
// 另有两条"物理隔离"铁律：
//   core 不得触碰 IO / DOM / 时间随机（纯函数优先，SAD §1.3）
//   业务公式不得写在 web 组件里（只能调 core 选择器，SAD §8）

import tseslint from 'typescript-eslint';

const IO_MODULES = [
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
  'path', 'node:path', 'os', 'node:os', 'child_process', 'node:child_process',
  'http', 'node:http', 'https', 'node:https', 'crypto', 'node:crypto',
  'node:sqlite', 'better-sqlite3', 'xlsx',
];

const DOM_GLOBALS = [
  { name: 'window', message: 'L5 内核禁止访问 DOM（SAD §1.3 纯函数优先）' },
  { name: 'document', message: 'L5 内核禁止访问 DOM（SAD §1.3 纯函数优先）' },
  { name: 'localStorage', message: 'L5 内核禁止访问浏览器存储' },
  { name: 'fetch', message: 'L5 内核禁止发起网络请求' },
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'data/**', 'docs/**'],
  },
  ...tseslint.configs.recommended,

  // ---- 全局：类型安全底线 ----
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ---- L5 内核：纯函数、零 IO、零 DOM、零反向依赖 ----
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...IO_MODULES.map((name) => ({ name, message: 'L5 内核必须保持纯函数：禁止 IO（SAD §1.3）' })),
            { name: '@origo/pipeline', message: '依赖倒置：内核不得依赖管道（SAD §2.1）' },
            { name: '@origo/web', message: '依赖倒置：内核不得依赖表现层（SAD §2.1）' },
          ],
          patterns: [
            { group: ['@origo/pipeline*', '@origo/web*'], message: '依赖倒置：core 只能被依赖，不反向依赖' },
            { group: ['**/pipeline/**', '**/web/**'], message: '依赖倒置：core 不得跨包引用' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...DOM_GLOBALS],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
          message: '内核禁止隐式取当前时间（不可测）：时间必须由调用方以参数注入',
        },
        {
          selector: 'CallExpression[callee.object.name="Math"][callee.property.name="random"]',
          message: '内核禁止使用随机数（不可复现）',
        },
      ],
    },
  },

  // ---- L4 管道：可碰 IO，但不得依赖表现层 ----
  {
    files: ['packages/pipeline/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['@origo/web*', '**/web/**'], message: '管道不得依赖表现层（SAD §2.1）' }],
        },
      ],
      'no-restricted-globals': ['error', ...DOM_GLOBALS],
    },
  },

  // ---- L6 表现层：禁止内联业务公式（只能调 core 选择器） ----
  {
    files: ['packages/web/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/pipeline/**', '@origo/pipeline*'], message: '前端不得依赖构建期管道（SAD §2.1）' },
            { group: ['fs', 'node:fs', 'path', 'node:path', 'crypto', 'node:crypto'], message: '浏览器端无 Node 内置模块' },
          ],
        },
      ],
      // 业务公式黑名单：这些计算必须来自 @origo/core
      '@typescript-eslint/no-restricted-syntax': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "BinaryExpression[operator='*'][left.property.name='unitCost']",
          message: '毛利公式必须调用 core.compute.skuMargin()，不得在组件内联（SAD §8）',
        },
      ],
    },
  },

  // ---- 测试文件放宽 ----
  {
    files: ['**/tests/**/*.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
