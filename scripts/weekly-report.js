#!/usr/bin/env node
/**
 * weekly-report.js — 每週區域衝浪預報（建議每週四執行）
 *
 * 輸出：public/data/weekly-report.json
 * 包含：北台灣 / 南台灣 / 東海岸（依 spots.json 中的 region 欄位）
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getSeasonalContext } from '../src/forecast-utils.js';

const execFileAsync = promisify(execFile);
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '..');
const DATA_DIR   = path.join(ROOT, 'public', 'data');
const SPOTS_FILE = path.join(ROOT, 'public', 'spots.json');

mkdirSync(DATA_DIR, { recursive: true });

// ── 取得本週日期範圍（今天起算 7 天，CST）───────────────────────────────────────
function getWeekRangeCST() {
  const cst = new Date(Date.now() + 8 * 3600_000);
  const weekStart = cst.toISOString().slice(0, 10);
  const end = new Date(cst.getTime() + 6 * 86400_000);
  const weekEnd = end.toISOString().slice(0, 10);
  return { weekStart, weekEnd };
}

// ── 取得 7 日海象資料 ──────────────────────────────────────────────────────────
async function fetchWeeklyMarineData(lat, lon) {
  const marineUrl = new URL('https://marine-api.open-meteo.com/v1/marine');
  marineUrl.searchParams.set('latitude',     lat);
  marineUrl.searchParams.set('longitude',    lon);
  marineUrl.searchParams.set('hourly', [
    'swell_wave_height', 'swell_wave_period', 'wind_wave_height',
  ].join(','));
  marineUrl.searchParams.set('timezone',      'Asia/Taipei');
  marineUrl.searchParams.set('forecast_days', '7');

  const windUrl = new URL('https://api.open-meteo.com/v1/forecast');
  windUrl.searchParams.set('latitude',        lat);
  windUrl.searchParams.set('longitude',       lon);
  windUrl.searchParams.set('hourly',          'wind_speed_10m');
  windUrl.searchParams.set('wind_speed_unit', 'ms');
  windUrl.searchParams.set('timezone',        'Asia/Taipei');
  windUrl.searchParams.set('forecast_days',   '7');

  const [marineRes, windRes] = await Promise.all([
    fetch(marineUrl.toString()),
    fetch(windUrl.toString()),
  ]);
  if (!marineRes.ok) throw new Error(`Marine API ${marineRes.status}`);
  if (!windRes.ok)   throw new Error(`Wind API ${windRes.status}`);

  const [marine, wind] = await Promise.all([marineRes.json(), windRes.json()]);

  const swellH    = marine.hourly.swell_wave_height ?? marine.hourly.wave_height ?? [];
  const swellP    = marine.hourly.swell_wave_period ?? marine.hourly.wave_period  ?? [];
  const windWaveH = marine.hourly.wind_wave_height ?? [];
  const windSpd   = wind.hourly.wind_speed_10m     ?? [];

  // Aggregate hourly → daily
  const daily = {};
  marine.hourly.time.forEach((t, i) => {
    const date = t.slice(0, 10);
    if (!daily[date]) daily[date] = { swellH: [], swellP: [], windWaveH: [], windSpd: [] };
    if (swellH[i]    != null) daily[date].swellH.push(swellH[i]);
    if (swellP[i]    != null) daily[date].swellP.push(swellP[i]);
    if (windWaveH[i] != null) daily[date].windWaveH.push(windWaveH[i]);
    if (windSpd[i]   != null) daily[date].windSpd.push(windSpd[i]);
  });

  const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const max = arr => arr.length ? Math.max(...arr) : null;
  const r1  = v    => v != null ? Math.round(v * 10) / 10 : null;
  const r0  = v    => v != null ? Math.round(v) : null;
  const WEEKDAYS = ['日','一','二','三','四','五','六'];

  return Object.entries(daily).map(([date, d]) => ({
    date,
    weekday:         `週${WEEKDAYS[new Date(date + 'T00:00:00').getDay()]}`,
    avg_swell_h_m:   r1(avg(d.swellH)),
    max_swell_h_m:   r1(max(d.swellH)),
    avg_swell_p_s:   r0(avg(d.swellP)),
    avg_wind_wave_m: r1(avg(d.windWaveH)),
    avg_wind_spd_ms: r1(avg(d.windSpd)),
  }));
}

// ── Claude 生成區域週報摘要 ───────────────────────────────────────────────────
async function generateRegionSummary(region, spots, dailyData, seasonalCtx) {
  const spotsDesc = spots.map(s => s.name).join('、');
  const daysText  = dailyData.map(d =>
    `  ${d.weekday}(${d.date.slice(5)})：湧浪均${d.avg_swell_h_m ?? '?'}m 週期${d.avg_swell_p_s ?? '?'}s，風浪${d.avg_wind_wave_m ?? '?'}m，風速${d.avg_wind_spd_ms ?? '?'}m/s`
  ).join('\n');

  const prompt = `你是台灣衝浪預報助理。你的回覆必須只包含 JSON，不可有任何說明文字或 markdown。

${seasonalCtx}

請根據以下 ${region} 未來 7 日海象，生成區域週報摘要。
代表浪點：${spotsDesc}

各日海象：
${daysText}

請輸出 JSON（不含說明文字或 markdown）：
{
  "overall_summary": "整週浪況概述，最多 40 字",
  "best_day": "最佳日，格式：週五(04/11)；若整週無好浪則填 無",
  "worst_day": "最差日，格式：週一(04/07)；若整週都差則填 整週偏弱",
  "highlight": "本週最重要的衝浪注意事項，含季節/颱風/季風提醒，最多 40 字",
  "daily_ratings": [
    {"date": "YYYY-MM-DD", "weekday": "週X", "rating": 1到5整數, "note": "最多10字"}
  ]
}`;

  let stdout;
  try {
    const result = await execFileAsync('claude', [
      '--print', prompt,
      '--output-format', 'json',
      '--disallowed-tools', 'Bash,Edit,Write,Read,Glob,Grep,Agent',
    ], { timeout: 90_000 });
    stdout = result.stdout;
  } catch (err) {
    console.error(`[weekly] Claude error for ${region}:`, err.message?.slice(0, 200));
    return null;
  }

  let envelope;
  try { envelope = JSON.parse(stdout); } catch { return null; }
  if (envelope.type !== 'result' || envelope.subtype !== 'success') return null;

  const jsonMatch = (envelope.result ?? '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try { return JSON.parse(jsonMatch[0]); } catch { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const spots = JSON.parse(readFileSync(SPOTS_FILE, 'utf8'));
const { weekStart, weekEnd } = getWeekRangeCST();
const seasonalCtx  = getSeasonalContext(weekStart);
const generatedAt  = new Date().toISOString();

console.log(`[weekly] ${weekStart} ~ ${weekEnd}`);
console.log(`[weekly] season: ${seasonalCtx.slice(0, 40)}...`);

// Group spots by region
const regionMap = {};
for (const spot of spots) {
  if (!regionMap[spot.region]) regionMap[spot.region] = [];
  regionMap[spot.region].push(spot);
}

const regionResults = [];

for (const [region, regionSpots] of Object.entries(regionMap)) {
  // Use the middle spot as representative (better geographic coverage)
  const rep = regionSpots[Math.floor(regionSpots.length / 2)];
  console.log(`[weekly] ${region}: fetching via ${rep.name} (${rep.lat},${rep.lon})...`);

  let dailyData;
  try {
    dailyData = await fetchWeeklyMarineData(rep.lat, rep.lon);
    console.log(`[weekly] ${region}: ${dailyData.length} days fetched`);
  } catch (err) {
    console.error(`[weekly] ${region} fetch error: ${err.message}`);
    regionResults.push({ region, spots: regionSpots.map(s => s.name), error: 'fetch_failed' });
    continue;
  }

  const summary = await generateRegionSummary(region, regionSpots, dailyData, seasonalCtx);

  if (!summary) {
    console.warn(`[weekly] ${region}: Claude summary failed, saving raw data only`);
    regionResults.push({
      region,
      spots:      regionSpots.map(s => s.name),
      raw_data:   dailyData,
      error:      'claude_failed',
    });
    continue;
  }

  console.log(`[weekly] ${region}: "${summary.overall_summary}"`);
  regionResults.push({
    region,
    spots:           regionSpots.map(s => s.name),
    overall_summary: summary.overall_summary,
    best_day:        summary.best_day,
    worst_day:       summary.worst_day,
    highlight:       summary.highlight,
    daily_ratings:   summary.daily_ratings,
    raw_data:        dailyData,
  });
}

const output = {
  generated_at:     generatedAt,
  week_start:       weekStart,
  week_end:         weekEnd,
  seasonal_context: seasonalCtx,
  regions:          regionResults,
};

const outFile = path.join(DATA_DIR, 'weekly-report.json');
writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log(`[weekly] saved → ${outFile}`);
