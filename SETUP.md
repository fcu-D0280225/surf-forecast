# 台灣衝浪助手 — 安裝與啟動指南

## 系統需求

- Node.js 18+
- ANTHROPIC_API_KEY（呼叫 Claude AI 用）

---

## 1. 安裝相依套件

```bash
cd surf-forecast
npm install
```

---

## 2. 設定 API Key

```bash
export ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
```

建議加到 `~/.zshrc` 或 `~/.bashrc` 讓每次開終端機都自動載入：

```bash
echo 'export ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx' >> ~/.zshrc
source ~/.zshrc
```

---

## 3. 新增使用者帳號

首次使用前必須先建立帳號（至少一個）：

```bash
node src/add-user.js add <username> <password> <顯示名稱>
```

範例：

```bash
node src/add-user.js add jackson mypassword 傑克森
```

其他管理指令：

```bash
node src/add-user.js list            # 列出所有使用者
node src/add-user.js delete jackson  # 刪除使用者
```

---

## 4. 啟動伺服器

```bash
npm run web
```

啟動後開啟瀏覽器：[http://localhost:3000](http://localhost:3000)

預設 port 為 3000，可用環境變數更改：

```bash
PORT=8080 npm run web
```

---

## 5. 手機安裝（PWA）

本專案已支援 PWA，可安裝到手機主畫面當作 App 使用。

> **重要**：手機必須能連到伺服器的網址，且需要 HTTPS（localhost 除外）。

### 方法 A：區域網路（LAN）

電腦與手機在同一個 Wi-Fi 下，直接用 IP 連線：

1. 查詢電腦的區域 IP：
   ```bash
   ipconfig getifaddr en0      # macOS Wi-Fi
   ip addr show | grep 'inet ' # Linux
   ```
2. 手機瀏覽器開啟 `http://192.168.x.x:3000`
3. 按照下方步驟「加入主畫面」

> 注意：區域網路用 http 時，Service Worker 不會啟用（僅 localhost 或 https 才支援），但基本功能仍可正常使用，也可加入主畫面。

### 方法 B：HTTPS 外網（完整 PWA 功能）

推薦用 [ngrok](https://ngrok.com/) 快速建立 HTTPS 通道：

```bash
# 安裝 ngrok（macOS）
brew install ngrok

# 伺服器跑在 3000，建立 https 通道
ngrok http 3000
```

ngrok 會給你一個 `https://xxxx.ngrok.io` 網址，用手機瀏覽器開啟即可。

---

## 6. 加入主畫面（手機操作）

### iOS（Safari）

1. 用 **Safari** 開啟 App 網址（Chrome 不支援加入主畫面）
2. 點下方**分享按鈕**（方框加箭頭）
3. 往下找「**加入主畫面**」
4. 確認名稱後點「新增」
5. 主畫面出現「衝浪助手」圖示，點開即全螢幕使用

### Android（Chrome）

1. 用 **Chrome** 開啟 App 網址
2. 瀏覽器右上角出現「**安裝應用程式**」提示 → 點安裝
3. 或點右上角選單 → 「加到主畫面」
4. 主畫面出現圖示，點開即全螢幕使用

---

## 功能說明

| 功能 | 說明 |
|------|------|
| 💬 問浪況 | 用自然語言問 AI，例如「墾丁今天適合衝浪嗎？」 |
| ✏️ 新增紀錄 | 填寫表單記錄今天的衝浪心得，海況數據自動抓取 |
| 📋 衝浪日誌 | 查看歷史紀錄，包含客觀海況資料 |
| 🔮 預測 | 根據歷史相似天氣預測未來浪況 |

---

## 目錄結構

```
surf-forecast/
├── src/
│   ├── web-server.js    # Express 主伺服器
│   ├── mcp-server.js    # MCP 工具伺服器
│   ├── auth.js          # 帳號 / Session 管理
│   ├── add-user.js      # 帳號管理 CLI
│   ├── surf-utils.js    # 地理定位 / 氣象 API
│   └── rag/store.js     # 衝浪紀錄 RAG 向量儲存
├── public/
│   ├── index.html       # 主頁面
│   ├── login.html       # 登入頁
│   ├── app.js           # 前端邏輯
│   ├── style.css        # 主樣式
│   ├── login.css        # 登入頁樣式
│   ├── manifest.json    # PWA Manifest
│   ├── sw.js            # Service Worker
│   └── icons/icon.svg   # App 圖示
├── data/
│   └── surf-rag.sqlite  # SQLite 資料庫（衝浪紀錄）
└── package.json
```
