#!/bin/bash
# Cron wrapper: 每週區域週報
# 用 claude --print（OAuth 訂閱額度）跑 weekly-report.js，
# 完成後把 public/data/weekly-report.json commit & push 回 origin/main。

# ─── 坑 1：載 nvm，讓 node / claude 進 PATH（cron 環境沒這個）───
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

REPO_DIR="/home/jacksonlin/repos/surf-forecast"
LOG="/home/jacksonlin/claude-cron/vm/surf-weekly.log"

cd "$REPO_DIR" || exit 1

# 網路檢查
if ! curl -s --max-time 5 https://www.google.com >/dev/null 2>&1; then
  echo "$(/bin/date '+%Y-%m-%d %H:%M') skipped: no network" >> "$LOG"
  exit 0
fi

# ─── 坑 2：確認 claude CLI 可用 ─────────────────────────────
if ! claude --version >/dev/null 2>&1; then
  echo "$(/bin/date '+%Y-%m-%d %H:%M') claude CLI broken, self-repair..." >> "$LOG"
  INSTALL="$(npm root -g 2>/dev/null)/@anthropic-ai/claude-code/install.cjs"
  [[ -f "$INSTALL" ]] && node "$INSTALL" >> "$LOG" 2>&1 || true
  if ! claude --version >/dev/null 2>&1; then
    echo "$(/bin/date '+%Y-%m-%d %H:%M') self-repair FAILED, aborting" >> "$LOG"
    exit 1
  fi
  echo "$(/bin/date '+%Y-%m-%d %H:%M') self-repair OK" >> "$LOG"
fi

echo "$(/bin/date '+%Y-%m-%d %H:%M') starting weekly report" >> "$LOG"

node scripts/weekly-report.js >> "$LOG" 2>&1
EXIT=$?

# 認證失敗時重試一次（OAuth token 可能剛過期）
if [[ $EXIT -ne 0 ]] && tail -30 "$LOG" | grep -qiE "authentication_error|401|unauthorized|oauth.*expired|token.*expired"; then
  echo "$(/bin/date '+%Y-%m-%d %H:%M') auth failed, retrying in 10s..." >> "$LOG"
  sleep 10
  node scripts/weekly-report.js >> "$LOG" 2>&1
  EXIT=$?
fi

echo "$(/bin/date '+%Y-%m-%d %H:%M') weekly done (exit $EXIT)" >> "$LOG"

# 只在成功且 weekly-report.json 真的有變動時才 commit/push
if [[ $EXIT -eq 0 ]] && ! git diff --quiet public/data/weekly-report.json; then
  WEEK=$(TZ=Asia/Taipei date '+%Y-W%V')
  git add public/data/weekly-report.json
  git commit -m "chore(data): weekly forecast ${WEEK}" >> "$LOG" 2>&1
  git push origin main >> "$LOG" 2>&1
  echo "$(/bin/date '+%Y-%m-%d %H:%M') pushed" >> "$LOG"
fi

exit $EXIT
