/**
 * server.js — 台灣衝浪助手後端
 *
 * API:
 *   POST /api/chat      白話文問浪況，回傳 Claude 回答
 *   POST /api/report    儲存自由文字浪況回饋到 RAG
 *   GET  /api/reports   列出近期回饋
 *
 * 靜態資源由 public/ 目錄提供。
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { insertReport, getRecentReports, listReports } from './rag-db.js';
import { getSeasonalContext } from './forecast-utils.js';
import {
  login, logout, getSession, cleanExpiredSessions,
  createUser, listUsers, deleteUser, userCount,
  setPoints, deductPoint, getUserInfo,
} from './auth.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR   = path.join(PUBLIC_DIR, 'data');
const SPOTS_FILE = path.join(PUBLIC_DIR, 'spots.json');
const PORT       = process.env.PORT || 4000;

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json());

// ── Request logger ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms  = Date.now() - start;
    const ts  = new Date().toTimeString().slice(0, 8);
    const col = res.statusCode >= 400 ? '\x1b[31m' : res.statusCode >= 300 ? '\x1b[33m' : '\x1b[32m';
    console.log(`${ts} ${col}${res.statusCode}\x1b[0m ${req.method} ${req.path} (${ms}ms)`);
  });
  next();
});

// sw.js 不可被 HTTP 快取，否則瀏覽器不會偵測到新版本
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
});

app.use(express.static(PUBLIC_DIR));

// ── Auth helpers ───────────────────────────────────────────────────────────────

function getToken(req) {
  // Cookie: surf_session=<token>
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/(?:^|;\s*)surf_session=([^;]+)/);
  return match ? match[1] : null;
}

function requireAuth(req, res, next) {
  const session = getSession(getToken(req));
  if (!session) return res.status(401).json({ error: '請先登入' });
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  const user = getUserInfo(req.session.user_id);
  if (!user?.is_admin) return res.status(403).json({ error: '需要管理員權限' });
  next();
}

cleanExpiredSessions();

// ── Auth routes ────────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: '請填寫帳號和密碼' });

  const result = login(username, password);
  if (!result) return res.status(401).json({ error: '帳號或密碼錯誤' });

  const maxAge = 30 * 24 * 3600;
  res.setHeader('Set-Cookie', `surf_session=${result.token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`);
  res.json({ username: result.username, displayName: result.displayName, isAdmin: result.isAdmin });
});

app.post('/api/auth/logout', (req, res) => {
  const token = getToken(req);
  if (token) logout(token);
  res.setHeader('Set-Cookie', 'surf_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const session = getSession(getToken(req));
  if (!session) return res.status(401).json({ error: '未登入' });
  const user = getUserInfo(session.user_id);
  if (!user) return res.status(401).json({ error: '未登入' });
  res.json({
    username:    user.username,
    displayName: user.display_name,
    isAdmin:     !!user.is_admin,
    points:      user.is_admin ? null : user.points,
  });
});

// ── Admin routes ───────────────────────────────────────────────────────────────

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  res.json(listUsers());
});

app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, displayName, isAdmin = false, points = 0 } = req.body ?? {};
  if (!username || !password || !displayName)
    return res.status(400).json({ error: '請填寫 username / password / displayName' });
  try {
    createUser(username, password, displayName, { isAdmin, points });
    res.json({ ok: true });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: '帳號已存在' });
    throw e;
  }
});

app.patch('/api/admin/users/:username/points', requireAuth, requireAdmin, (req, res) => {
  const { points } = req.body ?? {};
  if (typeof points !== 'number' || points < 0)
    return res.status(400).json({ error: 'points 必須為非負整數' });
  const ok = setPoints(req.params.username, Math.floor(points));
  ok ? res.json({ ok: true }) : res.status(404).json({ error: '找不到該用戶' });
});

app.delete('/api/admin/users/:username', requireAuth, requireAdmin, (req, res) => {
  const ok = deleteUser(req.params.username);
  ok ? res.json({ ok: true }) : res.status(404).json({ error: '找不到該用戶' });
});

// ── 讀取浪點設定 ───────────────────────────────────────────────────────────────
let spots = [];
try {
  spots = JSON.parse(readFileSync(SPOTS_FILE, 'utf8'));
} catch {
  console.warn('[server] spots.json not found');
}

function getForecastData(slug) {
  const file = path.join(DATA_DIR, `${slug}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// ── 呼叫 Claude CLI ────────────────────────────────────────────────────────────
async function askClaude(prompt) {
  const { stdout } = await execFileAsync('claude', [
    '--print', prompt,
    '--output-format', 'json',
    '--disallowed-tools', 'Bash,Edit,Write,Read,Glob,Grep,Agent',
  ], { timeout: 60_000 });

  const envelope = JSON.parse(stdout);
  if (envelope.type !== 'result' || envelope.subtype !== 'success') {
    throw new Error(`Claude CLI: ${envelope.subtype}`);
  }
  return envelope.result ?? '';
}

// ── 新浪點偵測與寫入 ────────────────────────────────────────────────────────────

/** 將新浪點寫入 spots.json，並更新記憶體中的 spots 陣列 */
function saveNewSpot(spotData) {
  // 防重複：name 已存在就跳過
  if (spots.some(s => s.name === spotData.name)) return false;

  const newSpot = {
    slug:        spotData.slug ?? spotData.name.replace(/\s+/g, '-').toLowerCase(),
    name:        spotData.name,
    lat:         spotData.lat,
    lon:         spotData.lon,
    description: spotData.description ?? '',
    region:      spotData.region ?? '未分類',
    sub_spots:   spotData.sub_spots ?? [],
  };

  spots.push(newSpot);
  writeFileSync(SPOTS_FILE, JSON.stringify(spots, null, 2), 'utf8');
  console.log(`[spots] ✚ 新增浪點：${newSpot.name} (${newSpot.slug})`);
  return true;
}

/** 從任意文字中偵測未知浪點，非同步執行，不阻塞主流程 */
async function detectNewSpots(text) {
  const knownNames = spots.map(s => s.name).join('、');
  const prompt = `你是台灣衝浪地理專家。
已知系統中的浪點清單：${knownNames}

以下文字中是否提到了清單以外的台灣衝浪地點？
「${text}」

若有，請對每個新地點輸出一個 JSON 物件（陣列），格式如下，不要輸出其他內容：
[{"name":"地點名","slug":"pinyin-slug","lat":緯度數字,"lon":經度數字,"region":"北台灣|南台灣|東海岸|西海岸","description":"一句話描述","sub_spots":["子地點1","子地點2"]}]

若沒有新地點，只輸出：[]`;

  try {
    const raw = await askClaude(prompt);
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return;
    const newSpots = JSON.parse(match[0]);
    for (const s of newSpots) {
      if (s.name && s.lat && s.lon) saveNewSpot(s);
    }
  } catch (err) {
    console.warn('[spots] 新浪點偵測失敗：', err.message);
  }
}

// ── POST /api/chat ─────────────────────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { question } = req.body ?? {};
  if (!question?.trim()) {
    return res.status(400).json({ error: 'question required' });
  }

  // 扣點（admin 不扣）
  const deduct = deductPoint(req.session.user_id);
  if (!deduct.success) {
    return res.status(402).json({ error: '點數不足，請聯絡管理員補充點數' });
  }

  // 各浪點今日預報摘要
  let forecastContext = '【各浪點今日預報】\n';
  for (const s of spots) {
    const f = getForecastData(s.slug);
    if (f && !f.stale) {
      const subSpotsNote = s.sub_spots?.length
        ? `（含：${s.sub_spots.join('、')}）`
        : '';
      const tideNote = (() => {
        if (!f.tides?.length) return '';
        const parts = f.tides.map(t =>
          `${t.type === 'high' ? '高潮' : '低潮'}${t.time}${t.height_m != null ? `(${t.height_m}m)` : ''}`
        ).join('/');
        return `，潮汐：${parts}`;
      })();
      forecastContext += `• ${s.name}${subSpotsNote}：${f.rating}星 — ${f.summary}`;
      forecastContext += `（湧浪${f.swell_height_m}m/${f.swell_period_s}s，風速${f.wind_speed_ms}m/s，最佳時窗${f.best_window_start}–${f.best_window_end}${tideNote}）\n`;
    }
  }

  // 近期用戶回報（RAG）
  const reports = getRecentReports(10);
  let ragContext = '';
  if (reports.length > 0) {
    ragContext = '\n【近期用戶回報（原文）】\n';
    for (const r of reports) {
      ragContext += `• ${r.created_at.slice(0, 10)}：${r.content}\n`;
    }
  }

  // 非同步偵測問題中是否提到新浪點（不阻塞回應）
  detectNewSpots(question).catch(() => {});

  // Detect if question specifies a time; if not, ask Claude to segment the day
  const hasTimeKeyword = /([0-9]{1,2}[:點時]|早上|下午|傍晚|清晨|早|午|晚|凌晨|幾點|時間|現在)/.test(question);
  const timeInstruction = hasTimeKeyword
    ? ''
    : `\n若問題未指定時間，請依潮汐或風向轉換將今日拆成 2–3 個時段（例如：早上 06–10、午後 10–15、傍晚 15–18），分別說明各時段浪況好壞與原因，以條列方式呈現。`;

  const todayCST = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const seasonalCtx = getSeasonalContext(todayCST);

  const prompt = `你是台灣衝浪助理，用繁體中文回答，語氣親切實用，回答不超過 150 字。
格式規定：純文字，不得使用 markdown、不得用星號（*）或井號（#）。回答必須以條列方式呈現，每個重點獨立一行，開頭用「•」符號，不寫大段落文字。
數據規定：除非用戶明確詢問數字（如浪高、週期、風速），否則不要在回答中提及任何數值，只說結論和建議。${timeInstruction}
${seasonalCtx}

以下是最新資料：
${forecastContext}${ragContext}

用戶問題：${question}`;

  try {
    const answer = await askClaude(prompt);

    // Match which spots Claude mentioned in the answer
    const mentionedSpots = spots
      .filter(s => answer.includes(s.name))
      .map(s => {
        const f = getForecastData(s.slug);
        if (!f) return null;
        return {
          slug:               s.slug,
          name:               s.name,
          region:             s.region,
          rating:             f.rating,
          best_window_start:  f.best_window_start,
          best_window_end:    f.best_window_end,
          summary:            f.summary,
          swell_height_m:     f.swell_height_m,
          swell_period_s:     f.swell_period_s,
          wind_speed_ms:      f.wind_speed_ms,
          confidence:         f.confidence,
        };
      })
      .filter(Boolean);

    res.json({ answer, spots: mentionedSpots, remainingPoints: deduct.points });
  } catch (err) {
    console.error('[chat] error:', err.message);
    res.status(500).json({ error: 'Claude 呼叫失敗，請稍後再試' });
  }
});

// ── POST /api/report ──────────────────────────────────────────────────────────
app.post('/api/report', (req, res) => {
  const { content } = req.body ?? {};
  if (!content?.trim()) {
    return res.status(400).json({ error: 'content 為必填' });
  }
  try {
    insertReport(content);
    // 非同步偵測回報中是否提到新浪點
    detectNewSpots(content).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('[report] error:', err.message);
    res.status(500).json({ error: '儲存失敗' });
  }
});

// ── GET /api/reports ──────────────────────────────────────────────────────────
app.get('/api/reports', (_req, res) => {
  res.json(listReports());
});

// ── Start ──────────────────────────────────────────────────────────────────────
const dataFiles = spots.map(s => {
  const f = getForecastData(s.slug);
  return f ? `  ✓ ${s.name} (${f.date}, ${f.rating}★)` : `  ✗ ${s.name} (無資料)`;
});

app.listen(PORT, () => {
  console.log('');
  console.log('🏄 城市浪人');
  console.log(`   http://localhost:${PORT}`);
  console.log(`   浪點資料：${spots.length} 個浪點`);
  dataFiles.forEach(l => console.log(l));
  console.log('');
  console.log('   API：');
  console.log(`   POST /api/chat    — 白話文問浪況`);
  console.log(`   POST /api/report  — 回報浪況`);
  console.log(`   GET  /api/reports — 列出回報`);
  console.log('');
  console.log('   Ctrl+C 停止');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n[server] 已停止');
  process.exit(0);
});
