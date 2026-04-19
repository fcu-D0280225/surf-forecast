# Surf Forecast — 資料庫 Schema 與建置指南

台灣衝浪預報 PWA，Express + MySQL + Claude Agent SDK，搭配 GitHub Actions 每日自動抓取中央氣象署資料並由 Claude 生成評級。

---

## 一、資料庫 Schema

- **資料庫**：MySQL（已從 SQLite 遷移）
- **字元集**：`utf8mb4` / `utf8mb4_unicode_ci`
- **初始化**：`src/db.js` 內 `initSchema()` 啟動時執行
- **預設 database 名稱**：`surf_forecast`

### Table 總覽

| # | Table | 用途 |
|---|-------|------|
| 1 | `users` | 使用者帳號 |
| 2 | `sessions` | 登入 session |
| 3 | `reports` | 自由文字浪況回饋 |
| 4 | `surf_log` | 浪況紀錄 + RAG 向量 |

### 1. users（`src/db.js:22-32`）
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INT AUTO_INCREMENT PK | |
| username | VARCHAR(64) UNIQUE | 全小寫 |
| display_name | VARCHAR(128) | |
| password_hash | VARCHAR(256) | pbkdf2（`salt:hash`） |
| is_admin | TINYINT(0\|1) | |
| points | INT default 0 | AI 查詢計費用 |
| created_at | DATETIME | |

### 2. sessions（`src/db.js:34-42`）
| 欄位 | 型別 | 說明 |
|------|------|------|
| token | VARCHAR(128) PK | 128 字元 hex |
| user_id | INT | |
| username | VARCHAR(64) | cache |
| display_name | VARCHAR(128) | cache |
| expires_at | DATETIME | 預設 30 天（`src/auth.js:8`） |

### 3. reports（`src/db.js:44-50`）
`id / content TEXT / created_at`

### 4. surf_log（`src/db.js:52-76`）
RAG + 海象資料合一：
| 欄位 | 型別 |
|------|------|
| id | INT PK |
| date_iso | VARCHAR(10) `YYYY-MM-DD` |
| spot | VARCHAR(255) |
| rating | VARCHAR(16) |
| notes | TEXT |
| content | TEXT（RAG chunk） |
| embedding | LONGBLOB（MiniLM-L6-v2 384 維 Float32Array） |
| wave_height_m / wave_period_s | DOUBLE |
| wind_speed_kmh / wind_direction_deg / wind_direction_text | DOUBLE/VARCHAR |
| swell_height_m / swell_period_s | DOUBLE |
| wave_direction_deg / wave_direction_text | DOUBLE/VARCHAR |
| water_temp_c | DOUBLE |
| weather_text | VARCHAR(64) |
| tide | VARCHAR(128) |
| created_at | DATETIME |

索引：`idx_surf_log_date` on `date_iso`

### 靜態資料檔

- `public/spots.json` — 12 個浪點設定（slug / name / lat / lon / region / tide_station / sub_spots）
- `public/data/<slug>.json` — 每日預報（由 GitHub Actions daily 18:00 CST 產出）
- `public/data/glossary.json` — 術語表

---

## 二、建置與啟動

### 環境需求
- **Node.js**：20 LTS（`Dockerfile` + GitHub Actions 皆指定 20）
- **Module**：ESM（`"type": "module"`）
- **MySQL**：8.x

### 環境變數

#### 本機開發 `.env`
```bash
# MySQL
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=app_user
MYSQL_PASSWORD=AppUser@2026!
MYSQL_DATABASE=surf_forecast

# Web Push（選用）
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

#### 遠端部署 `.env.deploy`（Makefile 用）
```bash
DEPLOY_HOST=your-server-ip
DEPLOY_USER=root
DEPLOY_PORT=22
DEPLOY_KEY=~/.ssh/id_rsa
DEPLOY_DIR=/root/surf-forecast
```

#### GitHub Actions Secrets
- `ANTHROPIC_API_KEY` — Claude API
- `CWA_API_KEY` — 中央氣象署 API

### 依賴安裝

```bash
npm install
```

### 開發模式

| 指令 | 說明 |
|------|------|
| `npm run dev` | 先 `forecast` 再 `nodemon src/server.js`（Port 4000） |
| `npm run serve` | 只啟伺服器，不重抓預報 |
| `npm run forecast` | 跑 `scripts/fetch-and-generate.js`（產生 `public/data/*.json`） |
| `npm run web` | 啟動 `src/web-server.js`（Port 3000，Web UI + Claude Agent） |

### 正式模式（Docker Compose）

```bash
docker compose up -d --build
```

`docker-compose.yml` 掛載：
- `./data:/app/data` — DB 資料持久化
- `./public/data:/app/public/data` — 預報 JSON（可 host-side `git pull` 更新而不重啟 container）

Container 暴露 Port **4000**。

### 部署（Makefile）

| 指令 | 動作 |
|------|------|
| `make setup` | 首次部署（SSH 到遠端 clone + `docker compose up -d --build`） |
| `make deploy` | `git push` 並觸發遠端 `git pull` + 智慧決定是否重建 container |
| `make logs` | `docker compose logs -f` |
| `make ssh` | SSH 進入遠端主機 |

`make deploy` 智慧判斷：變更只在 `public/data/`、`DEPLOY.md`、`TODOS.md`、`SETUP.md` 時不重建 container（見 `scripts/deploy.sh`）。

### 管理員帳號

```bash
# 本機
node scripts/create-admin.js <username> <password> [displayName]

# Docker
docker compose exec app node scripts/create-admin.js <username> <password> [displayName]
```

### SQLite → MySQL 遷移（若有舊資料）

```bash
node scripts/migrate-sqlite-to-mysql.js [--truncate]
# 來源：data/surf-rag.sqlite（users/sessions/surf_log）
#       data/feedback.sqlite（reports）
```

### 測試

```bash
npm test               # vitest
npm run test:watch
npm run test-prompt    # 測試 Claude prompt
```

### 主要 Port

| 服務 | Port |
|------|------|
| `src/server.js`（主要 API） | 4000 |
| `src/web-server.js`（Web UI） | 3000 |
| MySQL | 3306 |

### GitHub Actions

- `forecast.yml` — 每日 10:00 UTC（18:00 CST）`node scripts/fetch-and-generate.js`，commit + push `public/data/`
- `weekly-forecast.yml` — 每週產生 `node scripts/weekly-report.js`

### Dockerfile 重點

- Base：`node:20-alpine`（兩階段）
- Builder：裝 `python3 make g++` 編譯 `better-sqlite3` native binding，`npm ci --omit=dev`
- Runtime：用 `tini` 當 PID 1，`node src/server.js`
- 建立 `data/` 目錄供 volume 掛載

### API 端點

| 類別 | 端點 |
|------|------|
| Chat | `POST /api/chat` |
| Reports | `POST /api/report`、`GET /api/reports` |
| Auth | `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me` |
| Admin | `GET/POST /api/admin/users`、`PATCH /:username/points`、`DELETE /:username`、`GET/POST/DELETE /api/admin/glossary` |
