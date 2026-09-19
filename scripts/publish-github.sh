#!/usr/bin/env bash
# 推送到 GitHub 并开启 Pages。
#
# 前置：在 https://github.com/new 建好**空**仓库 origoaura-ops（不要勾 README / .gitignore / license）。
#
# 用法：
#   ./scripts/publish-github.sh            # 推送到 ttttttt930/origoaura-ops
#   ./scripts/publish-github.sh other/repo # 指定别的仓库
#
# 为什么用 git@github-deploy：<~/.ssh/config> 里为该 alias 配了专用密钥
# （IdentityFile ~/.ssh/id_ed25519_deploy），默认的 git@github.com 会被拒绝。
set -euo pipefail

REPO="${1:-ttttttt930/origoaura-ops}"
REMOTE_URL="git@github-deploy:${REPO}.git"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo "==> 目标仓库  ${REPO}"
echo "==> 当前分支  ${BRANCH}"

# 1) 门禁 —— 红就别推
npm run gate

# 2) 远端
if git remote get-url origin >/dev/null 2>&1; then
  echo "==> origin 已存在：$(git remote get-url origin)"
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
fi

# 3) 连通性自检（推之前先确认密钥能过）
echo "==> SSH 连通性自检"
ssh -T -o BatchMode=yes git@github-deploy 2>&1 | head -2 || true

# 4) 推送
echo "==> 推送 ${BRANCH} → ${REMOTE_URL}"
git push -u origin "$BRANCH"

echo
echo "==> 推送完成。接下来开启 Pages："
echo "    1) 打开 https://github.com/${REPO}/settings/pages"
echo "    2) Source 选「GitHub Actions」"
echo "    3) 首次部署约 1-2 分钟，完成后访问："
echo "       https://${REPO%%/*}.github.io/${REPO#*/}/"
echo "    4) 验证时用 ?bust=\$(date +%s) 绕过 CDN 缓存"
