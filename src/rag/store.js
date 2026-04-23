/**
 * 本機 RAG：MySQL 存文字 + 數值欄位，支援
 *  1) 數值加權距離搜尋（findSimilarByConditions，預設路徑，無外部 dep）
 *  2) 選用 MiniLM 文字向量搜尋（searchSurfLogs，需裝 @xenova/transformers）
 */
import { run, all } from '../db.js';

let embedder = null;

async function getEmbedder() {
  if (!embedder) {
    const { pipeline } = await import('@xenova/transformers');
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
  // Buffer.buffer may be shared and not 4-byte aligned; copy to ensure alignment.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/** 建立 RAG chunk 文字 */
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
 * @param withEmbedding 是否計算並寫入 MiniLM embedding（預設 false，走數值距離搜尋）
 */
export async function recordSurfLog({ dateIso, spot, rating, notes = '', conditions = {}, tide, withEmbedding = false } = {}) {
  const chunk = buildChunk({ dateIso, spot, rating, notes, conditions: { ...conditions, tide } });

  let embedBuffer = null;
  if (withEmbedding) {
    const vec = await embedText(chunk);
    embedBuffer = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  }

  const result = await run(
    `INSERT INTO surf_log
      (date_iso, spot, rating, notes, content, embedding,
       wave_height_m, wave_period_s, wind_speed_kmh,
       wind_direction_deg, wind_direction_text, swell_height_m, swell_period_s,
       wave_direction_deg, wave_direction_text, water_temp_c, weather_text, tide)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dateIso, spot, rating, notes || '', chunk, embedBuffer,
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
    ],
  );

  return { id: Number(result.insertId), content: chunk };
}

/** 文字向量相似度搜尋（只比對有 embedding 的列，沒 embedding 的列會被跳過） */
export async function searchSurfLogs({ query, topK = 5 } = {}) {
  const rows = await all(`
    SELECT id, date_iso, spot, rating, notes, content, embedding,
           wave_height_m, wave_period_s, wind_speed_kmh,
           wind_direction_deg, wind_direction_text, swell_height_m, swell_period_s,
           wave_direction_deg, wave_direction_text, water_temp_c, weather_text, tide
    FROM surf_log WHERE embedding IS NOT NULL ORDER BY id DESC
  `);

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

/**
 * 依數值條件找相似歷史紀錄（加權歐氏距離 + 風向圓周距離）
 *
 * @param {object} opts
 * @param {object} opts.conditions  目標條件（至少一個可比較欄位）
 * @param {string} [opts.spot]      限定同浪點（預設不限定）
 * @param {number} [opts.topK=5]
 * @param {object} [opts.weights]   各欄位權重；會覆蓋預設值
 * @returns 依 distance 升冪排序的歷史紀錄（含 distance 分數，越小越像）
 */
export const DEFAULT_CONDITION_WEIGHTS = Object.freeze({
  wave_height_m:      3,     // 浪高差 1m 貢獻 (3*1)^2 = 9
  wave_period_s:      1,     // 週期差 2s 貢獻 4
  swell_height_m:     2,     // 湧浪高差 1m 貢獻 4
  swell_period_s:     1,
  wind_speed_kmh:     0.2,   // 風速差 10 km/h 貢獻 4
  water_temp_c:       0.3,   // 水溫差 2°C 貢獻 0.36
  wind_direction_deg: 0.015, // 風向差 180° 貢獻 (0.015*180)^2 ≈ 7.3
  wave_direction_deg: 0.015,
});

const LINEAR_FIELDS   = ['wave_height_m','wave_period_s','swell_height_m','swell_period_s','wind_speed_kmh','water_temp_c'];
const CIRCULAR_FIELDS = ['wind_direction_deg','wave_direction_deg'];

export async function findSimilarByConditions({
  conditions = {},
  spot = null,
  topK = 5,
  weights: weightOverrides = {},
} = {}) {
  const weights = { ...DEFAULT_CONDITION_WEIGHTS, ...weightOverrides };
  const distTerms = [];
  const whereConds = [];
  const params = [];

  for (const f of LINEAR_FIELDS) {
    if (conditions[f] == null || !weights[f]) continue;
    distTerms.push(`POW((${f} - ?) * ${Number(weights[f])}, 2)`);
    params.push(conditions[f]);
    whereConds.push(`${f} IS NOT NULL`);
  }

  for (const f of CIRCULAR_FIELDS) {
    if (conditions[f] == null || !weights[f]) continue;
    // 圓周距離：min(|a-b|, 360-|a-b|)，最多 180°
    distTerms.push(`POW(LEAST(ABS(${f} - ?), 360 - ABS(${f} - ?)) * ${Number(weights[f])}, 2)`);
    params.push(conditions[f], conditions[f]);
    whereConds.push(`${f} IS NOT NULL`);
  }

  if (distTerms.length === 0) {
    throw new Error('findSimilarByConditions: conditions 必須至少包含一個可比較欄位');
  }

  let sql = `
    SELECT id, date_iso, spot, rating, notes,
           wave_height_m, wave_period_s, swell_height_m, swell_period_s,
           wave_direction_deg, wave_direction_text,
           wind_speed_kmh, wind_direction_deg, wind_direction_text,
           water_temp_c, weather_text, tide,
           ${distTerms.join(' + ')} AS distance
      FROM surf_log
     WHERE ${whereConds.join(' AND ')}`;

  if (spot) {
    sql += ` AND spot = ?`;
    params.push(spot);
  }

  // mysql2 execute() 對 LIMIT 參數型別挑剔（見 commit ba0387e），直接字面注入 sanitized 整數
  sql += ` ORDER BY distance ASC LIMIT ${Math.max(1, Math.floor(Number(topK) || 5))}`;

  const rows = await all(sql, params);
  return rows.map(r => ({
    id: r.id,
    date_iso: r.date_iso,
    spot: r.spot,
    rating: r.rating,
    notes: r.notes,
    conditions: {
      wave_height_m:       r.wave_height_m,
      wave_period_s:       r.wave_period_s,
      swell_height_m:      r.swell_height_m,
      swell_period_s:      r.swell_period_s,
      wave_direction_deg:  r.wave_direction_deg,
      wave_direction_text: r.wave_direction_text,
      wind_speed_kmh:      r.wind_speed_kmh,
      wind_direction_deg:  r.wind_direction_deg,
      wind_direction_text: r.wind_direction_text,
      water_temp_c:        r.water_temp_c,
      weather_text:        r.weather_text,
      tide:                r.tide,
    },
    distance: Number(Number(r.distance).toFixed(4)),
  }));
}
