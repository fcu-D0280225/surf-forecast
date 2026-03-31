/**
 * web-server.js — Surf Forecast Web UI（含登入認證）
 */
import express from 'express';
import { query } from '@anthropic-ai/claude-agent-sdk';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { login, logout, getSession, cleanExpiredSessions, userCount } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MCP_SERVER = path.join(__dirname, 'mcp-server.js');
const DB_PATH    = path.join(__dirname, '..', 'data', 'surf-rag.sqlite');
const PORT       = process.env.PORT || 3000;

cleanExpiredSessions();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Cookie 解析（不需套件）───────────────────────────────────────────────────
function parseCookies(req) {
  const map = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) map[k.trim()] = decodeURIComponent(v.join('='));
  });
  return map;
}

function setSessionCookie(res, token) {
  const maxAge = 30 * 24 * 60 * 60; // 30 天（秒）
  res.setHeader('Set-Cookie',
    `surf_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'surf_session=; HttpOnly; Path=/; Max-Age=0');
}

// ── 認證中介層 ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token   = parseCookies(req).surf_session;
  const session = getSession(token);
  if (!session) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: '請先登入' });
    }
    return res.redirect('/login');
  }
  req.user = { username: session.username, displayName: session.display_name };
  next();
}

// ── 登入頁 & 靜態資源（不需認證）─────────────────────────────────────────────
app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.use('/style.css',    express.static(path.join(PUBLIC_DIR, 'style.css')));
app.use('/login.css',    express.static(path.join(PUBLIC_DIR, 'login.css')));
// PWA 必要資源（不需認證）
app.use('/manifest.json', express.static(path.join(PUBLIC_DIR, 'manifest.json')));
app.use('/sw.js',         express.static(path.join(PUBLIC_DIR, 'sw.js')));
app.use('/icons',         express.static(path.join(PUBLIC_DIR, 'icons')));

// ── 登入 / 登出 API ───────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const result = login(username, password);
  if (!result) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  setSessionCookie(res, result.token);
  res.json({ ok: true, displayName: result.displayName });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req).surf_session;
  if (token) logout(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token   = parseCookies(req).surf_session;
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: '未登入' });
  res.json({ username: session.username, displayName: session.display_name });
});

// ── 以下路由全部需要登入 ──────────────────────────────────────────────────────
app.use(requireAuth);

// 主頁面與前端 JS
app.use(express.static(PUBLIC_DIR));

// ── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `你是一位專業的衝浪教練，擅長分析海況並給出建議。

當使用者詢問浪況時：
1. 使用 get_surf_forecast 工具取得即時資料
2. 若使用者要「記錄某一天浪況好不好／心得」，使用 record_surf_log
   → 系統會自動從 Open-Meteo 抓該天客觀數據（浪高、週期、風力、風向），不需手動輸入
3. 若使用者問過去衝過的紀錄、想回顧某類浪況，使用 search_surf_logs
4. 若使用者問「X 天後適合衝浪嗎」或「預測某日浪況」，使用 predict_surf_day
   → 工具會抓預報條件，並從歷史紀錄找相似天的評價，輔助預測
5. 用繁體中文分析並解釋浪況
6. 給出具體建議：適不適合衝浪、適合哪種程度的衝浪者

所有回覆請使用繁體中文。`;

// ── POST /api/chat ────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: '訊息不能為空' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // 在訊息前加上使用者名稱，供 AI 知道是誰在問
  const promptWithUser = `[${req.user.displayName}] ${message}`;

  try {
    for await (const msg of query({
      prompt: promptWithUser,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { 'surf-forecast': { command: 'node', args: [MCP_SERVER] } },
        maxTurns: 8,
        permissionMode: 'bypassPermissions',
      },
    })) {
      if (msg.type === 'tool_use') send({ type: 'status', text: `⚙️ 呼叫工具：${msg.name}` });
      if (msg.type === 'text' && msg.text) send({ type: 'text', text: msg.text });
      if ('result' in msg) {
        send({ type: 'done', text: msg.result });
        loadLogs(); // refresh after recording
      }
    }
  } catch (err) {
    send({ type: 'error', text: `錯誤：${err.message}` });
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

// ── POST /api/logs（直接表單寫入，不透過 AI）──────────────────────────────────
app.post('/api/logs', async (req, res) => {
  const { date, location, experience_rating, notes } = req.body;
  if (!date || !location || !experience_rating) {
    return res.status(400).json({ error: '日期、地點、評價為必填' });
  }
  try {
    const { recordSurfLog } = await import('./rag/store.js');
    const { geocode, fetchConditionsForDate } = await import('./surf-utils.js');
    const geo      = await geocode(location);
    const spotName = `${geo.name}（${geo.country ?? '台灣'}）`;
    let conditions = {};
    try {
      const fetched = await fetchConditionsForDate(geo.latitude, geo.longitude, date);
      conditions = fetched.conditions;
    } catch { /* 無法取得客觀數據時仍允許寫入 */ }
    const row = await recordSurfLog({
      dateIso: date, spot: spotName,
      rating:  experience_rating, notes: notes ?? '',
      conditions, tide: req.body.tide || null,
    });
    res.json({ ok: true, id: row.id, spot: spotName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/logs ─────────────────────────────────────────────────────────────
app.get('/api/logs', (_req, res) => {
  try {
    const rows = new Database(DB_PATH, { readonly: true }).prepare(`
      SELECT id, date_iso, spot, rating, notes,
             wave_height_m, wave_period_s, wind_speed_kmh, wind_direction_text, swell_height_m,
             wave_direction_text, water_temp_c, weather_text, tide
      FROM surf_log ORDER BY date_iso DESC, id DESC LIMIT 50
    `).all();
    res.json(rows);
  } catch { res.json([]); }
});

// no-op to avoid reference error (loadLogs is only meaningful client-side)
function loadLogs() {}

// ── 啟動 ──────────────────────────────────────────────────────────────────────
const count = userCount();
if (count === 0) {
  console.log('\n⚠️  尚無使用者，請先執行以下指令新增帳號：');
  console.log('   node src/add-user.js add <username> <password> <顯示名稱>\n');
}

app.listen(PORT, () => {
  console.log(`🌊 Surf Forecast Web UI`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   目前使用者數：${count}`);
});
