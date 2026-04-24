# 城市浪人 — 部署指南

## 前置需求

- VPS（Ubuntu 22.04 以上）
- Docker + Docker Compose
- 對外 port 80 / 443 開放
- 已有 domain（選填，用 IP 也可以跑）

---

## 一、安裝 Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# 重新登入讓 group 生效
```

---

## 二、部署 app

```bash
# Clone 專案
git clone https://github.com/fcu-D0280225/surf-forecast.git
cd surf-forecast

# 啟動容器
docker compose up -d

# 確認跑起來
docker compose ps
docker compose logs -f
```

預設跑在 `http://your-ip:4000`。

---

## 三、建立管理員帳號

```bash
docker compose exec app node scripts/create-admin.js <username> <password> <顯示名稱>

# 範例
docker compose exec app node scripts/create-admin.js admin mypassword 管理員
```

---

## 四、設定每日預報自動更新

VPS cron 每天 18:00（台灣時間）直接在本機跑 `scripts/cron-forecast.sh`，
透過 Claude Agent SDK + OAuth 訂閱額度產生預報，完成後 commit & push 回 origin/main。
VPS 容器掛載的程式碼也每小時 `git pull` 一次，**不需要重啟 container**。

```bash
crontab -e
```

加入這兩行：

```
# 每日衝浪預報 18:00 Asia/Taipei
0 18 * * * /home/<user>/repos/surf-forecast/scripts/cron-forecast.sh

# 每小時 git pull（讓週報等其他來源的資料同步進來）
0 * * * * cd /home/<user>/repos/surf-forecast && git pull --ff-only origin main >> /var/log/surf-pull.log 2>&1
```

需求：

- 用 `claude` CLI 登入過 OAuth（執行過 `claude` 互動模式並完成登入）
- `nvm` 安裝 node 20+（wrapper 內會 source `~/.nvm/nvm.sh`）
- repo 的 git remote 含有 `GITHUB_PAT`（讓 push 不用人工輸入密碼）

GitHub Actions 的 `Daily Surf Forecast` workflow 已關掉排程，只保留手動觸發作為後備
（VPS 故障時可以從 GitHub UI 觸發補跑）。

---

## 五、設定每週週末預報更新

週末週報也搬到 VPS cron，每週四 18:00（台灣時間）跑 `scripts/cron-weekly-report.sh`，
同樣走 `claude --print` + OAuth 訂閱額度，產出 `public/data/weekly-report.json` 後 commit & push。

加進同一份 crontab：

```
# 每週四衝浪週報 18:00 Asia/Taipei
0 18 * * 4 /home/<user>/repos/surf-forecast/scripts/cron-weekly-report.sh
```

GitHub Actions 的 `Weekly Regional Surf Forecast` workflow 已關掉排程，只保留手動觸發作為後備。

---

## 六、設定 GitHub Actions secrets

讓 GitHub Actions 能呼叫 Claude 產生預報：

1. 進入 `https://github.com/fcu-D0280225/surf-forecast/settings/secrets/actions`
2. 新增 secret：

| Name | 說明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API key（必填） |
| `CWA_API_KEY` | 氣象署 API key，用於潮汐資料（選填） |

手動觸發測試：
- `Actions → Daily Surf Forecast → Run workflow`
- `Actions → Weekly Regional Surf Forecast → Run workflow`

---

## 七、設定 HTTPS（選填，但 PWA 安裝需要）

使用 nginx + Let's Encrypt：

```bash
sudo apt install nginx certbot python3-certbot-nginx -y

# 取得憑證
sudo certbot --nginx -d yourdomain.com

# nginx 設定（/etc/nginx/sites-available/surf）
sudo tee /etc/nginx/sites-available/surf <<'EOF'
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/surf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 日常維護

### 更新程式碼

```bash
cd /root/surf-forecast
git pull origin main
docker compose up -d --build
```

### 查看 log

```bash
docker compose logs -f
```

### 備份資料庫

```bash
cp -r data/ backup-$(date +%Y%m%d)/
```

### 新增用戶

```bash
docker compose exec app node scripts/create-admin.js <username> <password> <顯示名稱>
```

管理員帳號登入後也可在 `/admin.html` 圖形介面新增一般用戶並設定點數。

---

## 資料目錄說明

| 路徑 | 內容 | 更新方式 |
|------|------|---------|
| `data/surf-rag.sqlite` | 用戶帳號、session | 由 app 寫入 |
| `data/feedback.sqlite` | 用戶浪況回報 | 由 app 寫入 |
| `public/data/*.json` | 各浪點每日預報 | VPS cron (`scripts/cron-forecast.sh`) |
| `public/data/weekly-report.json` | 週末區域週報 | VPS cron (`scripts/cron-weekly-report.sh`) |
| `public/data/glossary.json` | 在地術語表 | admin 介面修改後 git pull |
