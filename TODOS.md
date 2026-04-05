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
