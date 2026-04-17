# 城市浪人 — 台灣衝浪預報

台灣衝浪者的每日浪況預報 PWA，整合 AI 對話與 RAG 浪況知識庫。

## 功能

- **每日浪況預報**：涵蓋台灣 12 個衝浪點（北、東、南）
- **AI 對話**：整合 Claude，可用自然語言詢問浪況、裝備建議
- **RAG 知識庫**：向量搜尋本地衝浪知識，回答更精準
- **PWA**：可安裝至手機主畫面，離線瀏覽最新預報
- **深色模式**：自動跟隨系統設定
- **過期資料警示**：超過 3 天未更新顯示「資料中斷」紅色橫幅

## 衝浪點

北部：石門洞  
東部：花蓮、牛山呼庭、磯崎、水璉、松柏、東河、成功  
南部：佳樂水、墾丁南灣、旭光、玉光

## 技術棧

- **後端**：Node.js + Express
- **資料庫**：SQLite（surf-rag.sqlite — 向量 embedding，migrating to MySQL）
- **AI**：Claude SDK（`@anthropic-ai/sdk`）+ Agent SDK
- **部署**：Docker + Docker Compose
- **預報資料**：GitHub Actions 每日 18:00（台灣時間）自動更新 JSON

## 本機啟動

```bash
npm install
npm run dev
# 網頁介面：http://localhost:4000
```

## Docker 部署

```bash
git clone https://github.com/fcu-D0280225/surf-forecast.git
cd surf-forecast
docker compose up -d
# 預設跑在 http://your-ip:4000
```

建立管理員帳號：
```bash
docker compose exec app node scripts/create-admin.js <username> <password> <顯示名稱>
```

詳細部署步驟見 [DEPLOY.md](DEPLOY.md)。

## 預報資料更新

GitHub Actions 每日 18:00 台灣時間自動 fetch 並 commit 更新的 JSON 到 `public/data/`。VPS 每小時 `git pull` 一次，不需重啟 container。

## 待辦

- `DEFERRED-002` Cloudflare KV 跨裝置 feedback 同步
- `DEFERRED-004` Social sharing OG cards
- `DB-MIGRATE-004` SQLite → MySQL 遷移

詳見 [backlog](https://github.com/fcu-D0280225/claude-cron/blob/main/backlog/autonomous-tasks.md)。
