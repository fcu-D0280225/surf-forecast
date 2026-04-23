# TODOS

## Deferred from CEO Plan

- **Web Push VAPID** — 在驗證使用量後加入推播通知
- **Cloudflare KV 跨裝置 feedback 同步** — 目前 localStorage 只有單裝置
- **Seasonal spot suggestions** — 夏季推南灣、冬季推東北角（需要日期判斷邏輯）
- **Social sharing OG cards** — 截圖分享用

## From /plan-eng-review (2026-04-01)

### TODO-ENG-001: 連續 stale 警示機制
**What:** 如果 stale_since 超過 3 天，顯示「資料中斷」而非「略舊」。
**Why:** 用戶不知道浪點資料已中斷多天，還以為只是「略舊」。
**Pros:** 讓用戶知道該去查 Swelleye 備援。
**Cons:** 需要 UI 邏輯判斷 stale_since 差距；需要 GH Actions 失敗通知設定。
**Context:** stale_since 已改為只在首次失敗時寫入（保留原始故障時間），可直接計算距今天數。
**Depends on:** stale_since 首次寫入邏輯（已納入 eng review 決策）。

### TODO-ENG-002: IndexedDB 升級 feedback 儲存
**What:** 用 IndexedDB 取代 localStorage 儲存用戶回饋。
**Why:** iOS Safari 在儲存空間壓力下會驅逐 localStorage，回饋紀錄可能靜悄悄消失。
**Pros:** 更耐久的本地存儲；IndexedDB 不會被 iOS 驅逐。
**Cons:** API 較複雜（async）；需要重寫讀寫邏輯。
**Context:** MVP 接受 localStorage 的限制（失去回饋不影響核心功能）。升級至 Cloudflare KV 可同時實現跨裝置同步。
**Depends on:** 先確認 MVP 使用量值得投資再升級。

### ~~TODO-ENG-003: 設定每日 cron 自動更新預報資料~~ ✅ 已完成（改用 Mac launchd）
**解法：** 2026-04-XX nightly 改用 Mac launchd plist (`com.surf-forecast.daily`) + `mac/surf-forecast.sh`，呼叫 `node scripts/fetch-and-generate.js`，log 寫 `/tmp/surf-forecast-cron.log`。繞過 GH Actions。

## From /investigate session (2026-04-19)

背景：發現每週浪況預報停在 2026-04-06，每日預報停在 2026-04-17。手動跑完兩支腳本後推了 `80146ce chore(data): update surf forecast data 2026-04-20 + weekly report 2026-W17`。

### ~~TODO-ENG-004: 查 GH Actions 實際失敗原因~~ ❌ 作廢 2026-04-24
**作廢原因：** ENG-003 改用 Mac launchd 本機執行後，GH Actions workflow 已不再是 critical path，無需繼續追查根因。

### TODO-ENG-005: 修 Claude CLI 並行瓶頸（本機 launchd 仍有效）
**What:** `fetch-and-generate.js:141` 用 `Promise.allSettled(spots.map(processSpot))` 並行呼叫 12 個 `claude --print` 子進程。實測並行時全部卡在 60s timeout 被 SIGTERM（code 143）。單呼只要 15s。
**Why:** Anthropic 帳號的並行請求配額被打爆。即使本機 launchd 執行也會碰到相同問題，序列跑需要 ~3 分鐘。
**Options:**
- A) 加 p-limit 之類的 concurrency limit（例如 3）
- B) 改成完全序列（weekly-report.js 本來就是序列）
- Trade-off：A 快 (~1 分鐘)、B 穩 (~3 分鐘)

### ~~TODO-ENG-006: 釐清 Actions runner 上 `claude` CLI 的認證~~ ❌ 作廢 2026-04-24
**作廢原因：** 同 ENG-004，ENG-003 改 launchd 後不再需要 Actions runner 認證。

### ~~TODO-ENG-007: weekly-forecast.yml 從沒成功~~ ❌ 作廢 2026-04-24
**作廢原因：** 同 ENG-004/006。若要恢復 weekly 自動化，在 Mac launchd 加一條每週四排程即可，不必修 GH Actions。

### TODO-ENG-008: 移除日報字卡 UI + 決定後端去留
**What:** 使用者要求移除「瀏覽所有浪點」日報字卡，只保留週報字卡，當天浪況改為讓使用者在 chat 問。

**關鍵約束：** `server.js:283-300` 的 `/api/chat` 會遍歷 `spots.json`，對每個浪點讀 `public/data/{slug}.json`（rating/summary/湧浪/風速/潮汐）塞進 prompt。砍掉每日 cron 會讓 chat 失去差異化資料。

**三個選項（決策未定）：**
- **A. 全部移除**：砍 `forecast.yml` + `scripts/fetch-and-generate.js` + `public/data/*.json`（每日檔）。chat 降級成通用助理，失去差異化。
- **B. On-demand refactor**：砍排程與預生成，chat 在問題來時即時抓 Open-Meteo marine + 呼 Claude。資料最新，但每次問要 10–30s，開放式「哪個最好？」需並行抓 12 個（又會撞 ENG-005 並行瓶頸）。
- **C. 只改前端**：後端照跑，只刪前端日報字卡相關 HTML/JS。資源浪費但最安全，chat 照常用。

**前端刪除範圍（三個選項都適用）：**
- `public/index.html`：`<section class="browse-section">`、`#spot-selector` 面板、`#spot-toggle-btn`
- `public/app.js`：`loadForecasts` / `renderCards` / `buildCard` / `toggleCard` / `toggleBrowse` / `buildSpotSelector` / `toggleSpotSelector` / `onSpotToggle` / `selectAll` / `selectNone` / `renderAccuracy` / `getFeedback` / `LS_SELECTED` / `LS_FEEDBACK` / `addSeasonalSpot` button；保留 `allSpots`（chat 的 `hasLocationContext` 要用）
- 考慮保留或調整：header 的 `forecast-date`、refresh 按鈕、seasonal banner 的加入按鈕

**建議：** 若要作，傾向 B（符合「當天浪況用問的」精神），但需搭配 ENG-005 的並行限制一起解。
**Status:** 2026-04-19 討論後暫緩，等下次 session 決定方向再動。
