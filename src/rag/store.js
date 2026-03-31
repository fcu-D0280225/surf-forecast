/**
 * 本機 RAG：SQLite 存文字 + MiniLM 向量，用餘弦相似度檢索
 * v2：新增浪高、週期、風力、風向結構化欄位
 */
import Database from 'better-sqlite3';
import { pipeline } from '@xenova/transformers';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'surf-rag.sqlite');

let dbInstance = null;
let embedder = null;

function ensureDataDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getDb(dbPath = DEFAULT_DB_PATH) {
  if (!dbInstance) {
    ensureDataDir(dbPath);
    dbInstance = new Database(dbPath);

    // 建立基本 schema（舊資料庫不受影響）
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS surf_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_iso TEXT NOT NULL,
        spot TEXT NOT NULL,
        rating TEXT NOT NULL,
        notes TEXT,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_surf_log_date ON surf_log(date_iso);
    `);

    // Migration：逐一新增欄位（若已存在會拋錯，直接忽略）
    const newCols = [
      'wave_height_m REAL',
      'wave_period_s REAL',
      'wind_speed_kmh REAL',
      'wind_direction_deg REAL',
      'wind_direction_text TEXT',
      'swell_height_m REAL',
      'swell_period_s REAL',
      'wave_direction_deg REAL',
      'wave_direction_text TEXT',
      'water_temp_c REAL',
      'weather_text TEXT',
      'tide TEXT',
    ];
    for (const col of newCols) {
      try { dbInstance.exec(`ALTER TABLE surf_log ADD COLUMN ${col}`); } catch { /* 已存在 */ }
    }
  }
  return dbInstance;
}

async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedder;
}

/** @returns {Promise<Float32Array>} 已 L2 normalize */
export async function embedText(text) {
  const ext = await getEmbedder();
  const out = await ext(text, { pooling: 'mean', normalize: true });
  return out.data;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function bufferToFloat32(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

/**
 * 建立 RAG chunk 文字
 */
function buildChunk({ dateIso, spot, rating, notes, conditions = {} }) {
  const {
    wave_height_m, swell_height_m, wave_period_s,
    wind_speed_kmh, wind_direction_text,
    wave_direction_text, water_temp_c, weather_text, tide,
  } = conditions;

  const parts = [
    wave_height_m != null    ? `浪高:${wave_height_m.toFixed(1)}m`       : '',
    swell_height_m != null   ? `湧浪:${swell_height_m.toFixed(1)}m`      : '',
    wave_period_s != null    ? `週期:${Math.round(wave_period_s)}s`       : '',
    wave_direction_text      ? `浪向:${wave_direction_text}`              : '',
    wind_speed_kmh != null   ? `風速:${Math.round(wind_speed_kmh)}km/h`  : '',
    wind_direction_text      ? `風向:${wind_direction_text}`              : '',
    water_temp_c != null     ? `水溫:${water_temp_c.toFixed(1)}°C`       : '',
    weather_text             ? `天氣:${weather_text}`                     : '',
    tide                     ? `潮汐:${tide}`                             : '',
  ].filter(Boolean).join(' ');

  const n = (notes || '').trim();
  return [
    `[日期 ${dateIso}]`,
    `[地點 ${spot}]`,
    parts,
    `評價:${rating}。`,
    n ? `備註:${n}` : '',
  ].filter(Boolean).join(' ').trim();
}

/**
 * 寫入一筆衝浪紀錄
 * @param {{ dateIso, spot, rating, notes?, conditions?, tide?, dbPath? }} p
 * conditions = { wave_height_m, wave_period_s, wind_speed_kmh, wind_direction_deg,
 *                wind_direction_text, swell_height_m, swell_period_s,
 *                wave_direction_deg, wave_direction_text, water_temp_c, weather_text }
 */
export async function recordSurfLog({ dateIso, spot, rating, notes = '', conditions = {}, tide, dbPath } = {}) {
  const db = getDb(dbPath ?? DEFAULT_DB_PATH);
  const chunk = buildChunk({ dateIso, spot, rating, notes, conditions: { ...conditions, tide } });
  const vec = await embedText(chunk);
  const embedBytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);

  db.prepare(`
    INSERT INTO surf_log
      (date_iso, spot, rating, notes, content, embedding,
       wave_height_m, wave_period_s, wind_speed_kmh,
       wind_direction_deg, wind_direction_text, swell_height_m, swell_period_s,
       wave_direction_deg, wave_direction_text, water_temp_c, weather_text, tide)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    dateIso, spot, rating, notes || '', chunk, Buffer.from(embedBytes),
    conditions.wave_height_m        ?? null,
    conditions.wave_period_s        ?? null,
    conditions.wind_speed_kmh       ?? null,
    conditions.wind_direction_deg   ?? null,
    conditions.wind_direction_text  ?? null,
    conditions.swell_height_m       ?? null,
    conditions.swell_period_s       ?? null,
    conditions.wave_direction_deg   ?? null,
    conditions.wave_direction_text  ?? null,
    conditions.water_temp_c         ?? null,
    conditions.weather_text         ?? null,
    tide                            ?? null,
  );

  return {
    id: Number(db.prepare('SELECT last_insert_rowid() AS id').get().id),
    content: chunk,
  };
}

/**
 * 向量相似度搜尋
 */
export async function searchSurfLogs({ query, topK = 5, dbPath } = {}) {
  const db = getDb(dbPath ?? DEFAULT_DB_PATH);
  const rows = db.prepare(`
    SELECT id, date_iso, spot, rating, notes, content, embedding,
           wave_height_m, wave_period_s, wind_speed_kmh,
           wind_direction_deg, wind_direction_text, swell_height_m, swell_period_s,
           wave_direction_deg, wave_direction_text, water_temp_c, weather_text, tide
    FROM surf_log ORDER BY id DESC
  `).all();

  if (!rows.length) return [];

  const qVec = await embedText(query);
  return rows
    .map((row) => ({
      id: row.id,
      date_iso: row.date_iso,
      spot: row.spot,
      rating: row.rating,
      notes: row.notes,
      content: row.content,
      conditions: {
        wave_height_m:       row.wave_height_m,
        wave_period_s:       row.wave_period_s,
        wind_speed_kmh:      row.wind_speed_kmh,
        wind_direction_deg:  row.wind_direction_deg,
        wind_direction_text: row.wind_direction_text,
        swell_height_m:      row.swell_height_m,
        swell_period_s:      row.swell_period_s,
        wave_direction_deg:  row.wave_direction_deg,
        wave_direction_text: row.wave_direction_text,
        water_temp_c:        row.water_temp_c,
        weather_text:        row.weather_text,
        tide:                row.tide,
      },
      score: cosineSimilarity(qVec, bufferToFloat32(row.embedding)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ score, ...rest }) => ({ ...rest, score: Number(score.toFixed(4)) }));
}
