/**
 * web-server.js — Surf Forecast Web UI（含登入認證）
 */
import 'dotenv/config';
import express from 'express';
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'path';
import { fileURLToPath } from 'url';
import { login, logout, getSession, cleanExpiredSessions, userCount } from './auth.js';
import { all, first, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MCP_SERVER = path.join(__dirname, 'mcp-server.js');
const PORT       = process.env.PORT || 3000;

await initDb();
await cleanExpiredSessions();

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
async function requireAuth(req, res, next) {
  const token   = parseCookies(req).surf_session;
  const session = await getSession(token);
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
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await login(username, password);
  if (!result) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  setSessionCookie(res, result.token);
  res.json({ ok: true, displayName: result.displayName });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = parseCookies(req).surf_session;
  if (token) await logout(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const token   = parseCookies(req).surf_session;
  const session = await getSession(token);
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
   → 預測時務必參考下方「使用者個人好浪條件」，將預報數值與個人統計對比後給出結論
5. 用繁體中文分析並解釋浪況
6. 給出具體建議：適不適合衝浪、適合哪種程度的衝浪者

所有回覆請使用繁體中文。`;

/**
 * 從 DB 讀取個人統計，組成 system prompt 的補充段落。
 * 紀錄數不足時回傳空字串，不影響正常使用。
 */
async function buildStatsContext() {
  try {
    const totalRow = await first('SELECT COUNT(*) AS n FROM surf_log');
    const total = totalRow?.n ?? 0;
    if (total === 0) return '';

    const avgCond = await all(`
      SELECT rating,
        ROUND(AVG(wave_height_m),  1) AS wave_h,
        ROUND(AVG(swell_height_m), 1) AS swell_h,
        ROUND(AVG(wave_period_s),  0) AS period,
        ROUND(AVG(wind_speed_kmh), 0) AS wind,
        COUNT(*) AS n
      FROM surf_log
      WHERE wave_height_m IS NOT NULL
      GROUP BY rating
      ORDER BY CASE rating WHEN '好' THEN 1 WHEN '普通' THEN 2 ELSE 3 END
    `);

    const bySpot = await all(`
      SELECT spot,
        COUNT(*) AS total,
        SUM(CASE WHEN rating = '好' THEN 1 ELSE 0 END) AS good
      FROM surf_log
      GROUP BY spot
      ORDER BY total DESC
      LIMIT 8
    `);

    let ctx = `\n\n## 使用者個人好浪條件（來自歷史 ${total} 筆衝浪紀錄）\n`;
    ctx += '預測時請將預報數值與下表對比，判斷本次預報條件偏向哪個評價等級。\n';

    if (avgCond.length) {
      ctx += '\n### 各評價的平均客觀條件\n';
      ctx += '| 評價 | 平均浪高 | 平均湧浪 | 平均週期 | 平均風速 | 樣本數 |\n';
      ctx += '|:----:|:-------:|:-------:|:-------:|:-------:|:------:|\n';
      for (const r of avgCond) {
        const fmt = (v, u) => v != null ? `${v}${u}` : '—';
        ctx += `| ${r.rating} | ${fmt(r.wave_h,'m')} | ${fmt(r.swell_h,'m')} | ${fmt(r.period,'s')} | ${fmt(r.wind,'km/h')} | ${r.n} 次 |\n`;
      }
    }

    if (bySpot.length) {
      ctx += '\n### 各浪點好浪率\n';
      for (const s of bySpot) {
        const rate = Math.round(s.good / s.total * 100);
        ctx += `- ${s.spot}：${s.total} 次出海，好浪率 **${rate}%**\n`;
      }
    }

    ctx += '\n預測結論請直接說明：「根據你的歷史數據，這次預報條件偏向○○，建議○○」。';
    return ctx;
  } catch {
    return '';
  }
}

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

  // 每次請求都讀最新統計，確保剛記錄的資料立刻生效
  const systemPrompt = SYSTEM_PROMPT + await buildStatsContext();

  try {
    for await (const msg of query({
      prompt: promptWithUser,
      options: {
        systemPrompt,
        mcpServers: { 'surf-forecast': { command: 'node', args: [MCP_SERVER] } },
        maxTurns: 8,
        permissionMode: 'bypassPermissions',
      },
    })) {
      if (msg.type === 'tool_use') send({ type: 'status', text: `⚙️ 呼叫工具：${msg.name}` });
      if (msg.type === 'text' && msg.text) send({ type: 'text', text: msg.text });
      if ('result' in msg) {
        send({ type: 'done', text: msg.result });
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
app.get('/api/logs', async (_req, res) => {
  try {
    const rows = await all(`
      SELECT id, date_iso, spot, rating, notes,
             wave_height_m, wave_period_s, wind_speed_kmh, wind_direction_text, swell_height_m,
             wave_direction_text, water_temp_c, weather_text, tide
      FROM surf_log ORDER BY date_iso DESC, id DESC LIMIT 50
    `);
    res.json(rows);
  } catch { res.json([]); }
});

// ── GET /api/stats ────────────────────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const overview = await first(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN rating = '好'   THEN 1 ELSE 0 END) AS good,
        SUM(CASE WHEN rating = '普通' THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN rating = '不好' THEN 1 ELSE 0 END) AS bad
      FROM surf_log
    `);

    const bySpot = await all(`
      SELECT spot,
        COUNT(*) AS total,
        SUM(CASE WHEN rating = '好'   THEN 1 ELSE 0 END) AS good,
        SUM(CASE WHEN rating = '普通' THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN rating = '不好' THEN 1 ELSE 0 END) AS bad
      FROM surf_log
      GROUP BY spot
      ORDER BY total DESC
      LIMIT 10
    `);

    const byMonth = await all(`
      SELECT DATE_FORMAT(date_iso, '%Y-%m') AS month,
        COUNT(*) AS total,
        SUM(CASE WHEN rating = '好'   THEN 1 ELSE 0 END) AS good,
        SUM(CASE WHEN rating = '普通' THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN rating = '不好' THEN 1 ELSE 0 END) AS bad
      FROM surf_log
      GROUP BY month
      ORDER BY month ASC
      LIMIT 12
    `);

    const avgConditions = await all(`
      SELECT rating,
        ROUND(AVG(wave_height_m),  1) AS avg_wave_height,
        ROUND(AVG(wave_period_s),  0) AS avg_wave_period,
        ROUND(AVG(wind_speed_kmh), 0) AS avg_wind_speed,
        ROUND(AVG(swell_height_m), 1) AS avg_swell_height
      FROM surf_log
      WHERE wave_height_m IS NOT NULL
      GROUP BY rating
      ORDER BY CASE rating WHEN '好' THEN 1 WHEN '普通' THEN 2 ELSE 3 END
    `);

    res.json({ overview, bySpot, byMonth, avgConditions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 啟動 ──────────────────────────────────────────────────────────────────────
const count = await userCount();
if (count === 0) {
  console.log('\n⚠️  尚無使用者，請先執行以下指令新增帳號：');
  console.log('   node src/add-user.js add <username> <password> <顯示名稱>\n');
}

app.listen(PORT, () => {
  console.log(`🌊 Surf Forecast Web UI`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   目前使用者數：${count}`);
});
