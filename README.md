# origoaura-ops · 时法经营看板 V10

单品牌香水电商的经营驾驶舱。**无后端**：数据管道在构建期跑完，产出加密快照，前端纯静态。

- 线上：<https://ttttttt930.github.io/origoaura-ops/>（GitHub Pages，main 分支推送后自动部署）
- 与 V9 的关系：V9（<https://ttttttt930.github.io/marketing-report/>）继续在线，V10 独立仓库并行，未完成切换前不动 V9。

## 分层

```
packages/core      L5 领域内核 · 单一事实源（纯 TS，零 IO / 零 DOM）
packages/pipeline  L4 构建期数据管道（Excel → 规范化 → DQ 闸门 → 加密快照）
packages/web       L6 静态 SPA（Vite + TS，GitHub Pages）
```

依赖方向由 eslint 强制：`web → core`、`pipeline → core`、`core → 谁也不依赖`。
**业务口径只在 core 定义一次**，界面与管道都只能调用，不得各算一份。

## 常用命令

```bash
npm ci
npm run gate            # 类型检查 + lint + 测试（111 个）
npm run origo -- ingest data/raw/营销发展日报.xlsx   # 读原始表 → canonical（默认吃全部 N月汇总）
npm run origo -- validate                            # 跑 DQ 闸门，有 block 则退出码 1
npm run origo -- build                               # 校验通过后产出加密快照
npm run build:web                                    # 构建 dist/
```

## 数据质量闸门

11 条 DQ 规则是**发布闸门**：block 存在则管道拒绝产出快照（不是页面上的小红点）。

在真实全量数据（2026-01-01 ~ 2026-09-30，272 天）上，闸门抓到：

| 规则 | 条数 | 说明 |
|---|---|---|
| `EXPENSE_EQUALS_PARTS` | 27 | 「总览/支出」少计退款 —— 即历史上那起 ¥6,391 事故，7 月有 26 天、1 月 1 天 |
| `NET_EQUALS_REV_MINUS_EXP` | 2 | 净收入公式漏减退款 |
| `PLATFORM_SUM_EQUALS_TOTAL` | 1 | 1/31 源表有重复行，平台合计被双计 |
| `NO_DUP_DATE` | 1 (warn) | 同上 |
| `CELL_FORMAT` | 2 (warn) | 6 月 22 个、7 月 15 个数值单元格是**文本型**（7 月是带千分位的 `"1,291.44"`），已正确解析并留痕 |

> 7 月那个数字值得记一笔：某外部实现把带千分位的文本当成无法解析 → 置 0，
> 于是 15 天平台收入凭空少计 ¥20,673.09。内核的 `parseNumeric()` 会剥掉千分位并标记
> `coerced`，由 `CELL_FORMAT` 报 warn，绝不静默置 0（见 `packages/core/tests/cellformat.test.ts`）。

## 测试夹具

`packages/core/tests/fixtures/golden/` 里的两份夹具来自外部 M0/M1 产物，
**逐月对账后都不是整份可信**，只取对齐的部分做回归。取证过程与处置见
[`fixtures/golden/README.md`](packages/core/tests/fixtures/golden/README.md)。

## 什么不入库（重要）

快照用 AES-256-GCM + PBKDF2-SHA256(150k) 加密，口令由 `data/.secret` 持有（不入库），
所以 `packages/web/public/marketing-data.*` 可以公开。**但下面这几类是明文，不进公开仓**：

| 不入库 | 原因 | 替代 |
|---|---|---|
| `docs/*.png` `*.jpg` `*.gif` `*.webm` | 解锁后的看板截图带着**解密后的真实数字**，公开出去等价于绕过快照口令 | 演示图各存本地 |
| `data/master/sku-bom.json` | 供应商名称 + 逐组件核价（成本结构） | `sku-bom.example.json` |
| `data/master/platform-fees.json` | 各平台扣点、物流单价的实测值 | `platform-fees.example.json` |
| `data/master/inventory.json` | 实际在库/在途量 | `inventory.example.json` |
| `data/master/targets.json` | 月度营收/利润目标 | `targets.example.json` |
| `data/raw/*` `data/canonical/*` `.origo-key` `data/.secret` | 原始报表与密钥 | 本机自备 |

**新环境起步**（`npm run gate` 与 `npm run build:web` 都不依赖这些文件，纯前端构建可直接跑）：

```bash
for f in sku-bom platform-fees inventory targets; do
  cp data/master/$f.example.json data/master/$f.json
done
```

要跑 `origo ingest / validate / build` 才需要把真实值填回去，并把原始 xlsx 放进 `data/raw/`。

> 注意：`.gitignore` 只对**未跟踪**文件生效。如果一个敏感文件已经被 `git add` 过，
> 之后再写忽略规则是没用的 —— 必须 `git rm --cached <file>` 把它从索引摘掉，
> 而且它仍留在历史里。本仓库因为尚未推送，直接重建了历史，所以没有这个问题。
