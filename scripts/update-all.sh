#!/usr/bin/env bash
#
# update-all —— 改完数据后一条命令走到上线
#
# 顺序是刻意固定的：SKU 主数据 → 经营流水 ingest → DQ 闸门 → 加密快照 → 前端构建 → 推送。
# 任何一步失败就停（set -e），绝不"跳过闸门先把快照发出去"。
#
# 用法：
#   ./scripts/update-all.sh                    # 全流程（含 ingest 与 push）
#   ./scripts/update-all.sh --skip-ingest      # Excel 没变，只改了政策参数/主数据
#   ./scripts/update-all.sh --no-push          # 本地跑完，自己检查后再推
#   ./scripts/update-all.sh -m "补 9 月数据"    # 指定提交信息
#   ./scripts/update-all.sh --sheets "9月汇总"  # 只解析指定月表（源表还没修好时用）
#
# 前置：Excel 放在 data/raw/，口令在 .origo-key（或 ORIGO_PASSWORD）。
#
# 闸门失败时会把 canonical 自动回滚到 ingest 前的版本，不会冲掉线上正在用的数据。
set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_INGEST=0
NO_PUSH=0
MSG=""
SHEETS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-ingest) SKIP_INGEST=1; shift ;;
    --no-push)     NO_PUSH=1; shift ;;
    --sheets)      SHEETS="${2:-}"; shift 2 ;;
    -m|--message)  MSG="${2:-}"; shift 2 ;;
    -h|--help)     sed -n '3,16p' "$0"; exit 0 ;;
    *) echo "✗ 未知参数：$1（试试 --help）"; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- 1 · SKU 主数据
step "1/6 SKU 主数据同步（源库 → 主数据）"
if npm run sku:sync --silent; then
  echo "  主数据已重建"
else
  echo "  ⚠ 同步跳过或失败（源库未挂载？）。沿用现有 data/master/sku-bom.json 继续。"
fi

step "1b/6 SKU 漂移检测"
if npm run sku:check --silent; then
  echo "  ✓ 无漂移"
else
  echo
  echo "  ✗ 主数据与源库不一致。上面已列出差异，请先看清楚再决定："
  echo "     源库是对的 → 它已经同步过了，重跑本脚本即可"
  echo "     主数据是对的 → 去改源库（products/product_bom/product_quotes）"
  exit 1
fi

# ---------------------------------------------------------------- 2 · 经营流水
CANON="data/canonical/canonical.json"
PREBAK="data/canonical/canonical.pre-ingest.bak.json"

if [[ $SKIP_INGEST -eq 0 ]]; then
  step "2/6 读取 Excel → canonical"
  XLSX="$(ls -t data/raw/*.xlsx 2>/dev/null | head -1 || true)"
  if [[ -z "$XLSX" ]]; then
    echo "  ✗ data/raw/ 下没有 xlsx。把导出的报表放进来再跑。"
    exit 1
  fi
  echo "  源文件：$XLSX"
  # ingest 前先备份：一旦新数据过不了闸门，要能退回上一个可用状态。
  # （不这么做的话，一次失败的 ingest 会把线上正在用的 canonical 冲掉。）
  [[ -f "$CANON" ]] && cp "$CANON" "$PREBAK"
  if [[ -n "$SHEETS" ]]; then
    echo "  只解析工作表：$SHEETS"
    npm run origo --silent -- ingest "$XLSX" --sheets "$SHEETS"
  else
    echo "  解析全部月表（只想发某几个月请用 --sheets \"9月汇总\"）"
    npm run origo --silent -- ingest "$XLSX"
  fi
else
  step "2/6 跳过 ingest（--skip-ingest）"
fi

# ---------------------------------------------------------------- 3 · DQ 闸门
step "3/6 数据质量闸门"
if ! npm run origo --silent -- validate; then
  echo
  echo "  ✗ 闸门没过 —— 按设计不产出快照。"
  echo "    宁可今天没有新数据，也不让错数据进可信链路。"
  if [[ -f "$PREBAK" ]]; then
    cp "$PREBAK" "$CANON"
    echo
    echo "  已把 canonical 回滚到 ingest 前的版本（$PREBAK），"
    echo "  线上数据不受影响。回滚后复检："
    npm run origo --silent -- validate || true
  fi
  echo
  echo "  照上面列出的日期去源表修正，改完重跑本脚本。"
  echo "  只想先发可用的月份：./scripts/update-all.sh --sheets \"9月汇总\""
  exit 1
fi
echo "  ✓ 闸门通过"

# ---------------------------------------------------------------- 4 · 加密快照
step "4/6 加密快照"
npm run origo --silent -- build

# ---------------------------------------------------------------- 5 · 前端构建
step "5/6 前端构建"
npm run build:web --silent

# ---------------------------------------------------------------- 6 · 提交推送
step "6/6 提交与推送"
if [[ -z "$MSG" ]]; then
  MSG="数据更新 $(date +%Y-%m-%d' '%H:%M)"
fi

if [[ -z "$(git status --porcelain)" ]]; then
  echo "  没有需要提交的改动。"
else
  git add -A
  git commit -q -m "$MSG"
  echo "  已提交：$MSG"
fi

if [[ $NO_PUSH -eq 0 ]]; then
  git push
  echo
  echo "  ✓ 已推送。Pages 约 1-2 分钟生效，验证时加 ?bust=\$(date +%s) 绕过 CDN 缓存。"
else
  echo "  --no-push：已停在本地，确认无误后自行 git push。"
fi

step "完成"
