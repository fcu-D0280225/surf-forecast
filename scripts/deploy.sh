#!/usr/bin/env bash
# 從本機部署到遠端主機
# 用法：./scripts/deploy.sh [--setup]
#   --setup  第一次部署（clone + 啟動）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── 讀設定 ────────────────────────────────────────────────────────────────────
ENV_FILE="$ROOT_DIR/.env.deploy"
if [ ! -f "$ENV_FILE" ]; then
  echo "❌ 找不到 .env.deploy"
  echo "   請複製 .env.deploy.example 並填入主機資訊："
  echo "   cp .env.deploy.example .env.deploy"
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_rsa}"

SSH_OPTS="-p $DEPLOY_PORT -i $DEPLOY_KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

echo "🚀 部署目標：$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_DIR"

# ── 先 push 本機最新 commit ────────────────────────────────────────────────────
echo ""
echo "==> 推送本機 commit 到 GitHub..."
git -C "$ROOT_DIR" push origin main

# ── 連進主機執行 ───────────────────────────────────────────────────────────────
if [ "${1:-}" = "--setup" ]; then
  echo ""
  echo "==> 第一次部署：clone + 啟動..."
  # shellcheck disable=SC2087
  ssh $SSH_OPTS "$DEPLOY_USER@$DEPLOY_HOST" bash <<REMOTE
set -euo pipefail
if [ -d "$DEPLOY_DIR" ]; then
  echo "   目錄已存在，跳過 clone"
else
  git clone https://github.com/fcu-D0280225/surf-forecast.git "$DEPLOY_DIR"
fi
cd "$DEPLOY_DIR"
docker compose up -d --build
echo ""
echo "✅ 啟動完成，請建立管理員帳號："
echo "   docker compose exec app node scripts/create-admin.js <user> <pass> <名稱>"
REMOTE

else
  # ── 一般更新部署 ────────────────────────────────────────────────────────────
  echo ""
  echo "==> 更新主機..."
  # shellcheck disable=SC2087
  ssh $SSH_OPTS "$DEPLOY_USER@$DEPLOY_HOST" bash <<REMOTE
set -euo pipefail
cd "$DEPLOY_DIR"

OLD=\$(git rev-parse HEAD)
git pull --ff-only origin main
NEW=\$(git rev-parse HEAD)

if [ "\$OLD" = "\$NEW" ]; then
  echo "   已是最新版本"
  exit 0
fi

echo "   更新了以下檔案："
git diff --name-only "\$OLD" "\$NEW" | sed 's/^/   • /'

# 判斷是否有程式碼異動（排除純資料更新）
CODE_CHANGED=\$(git diff --name-only "\$OLD" "\$NEW" \
  | grep -v '^public/data/' \
  | grep -v '^DEPLOY.md' \
  | grep -v '^TODOS.md' \
  | grep -v '^SETUP.md' \
  | wc -l | tr -d ' ')

if [ "\$CODE_CHANGED" -gt 0 ]; then
  echo ""
  echo "==> 程式碼有更新，重新 build..."
  docker compose up -d --build
  echo "✅ 部署完成（重新 build）"
else
  echo ""
  echo "✅ 只有資料更新，container 無需重啟"
fi
REMOTE
fi

echo ""
echo "🌊 部署成功"
