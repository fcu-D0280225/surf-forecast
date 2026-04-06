#!/usr/bin/env node
/**
 * fetch-and-generate.js — 每日 cron 腳本
 *
 * 用法（GitHub Actions）：
 *   ANTHROPIC_API_KEY=sk-ant-xxx node scripts/fetch-and-generate.js
 *
 * 輸出：public/data/{spot-slug}.json（每個浪點一個檔）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { fetchMarineData, callClaude, fetchTides } from '../src/forecast-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'public', 'data');
const SPOTS_FILE = path.join(ROOT, 'public', 'spots.json');

mkdirSync(DATA_DIR, { recursive: true });

// ── 計算明天日期（CST / Asia/Taipei）────────────────────────────────────────
function getTomorrowCST() {
  const now = new Date();
  // 轉成 CST (UTC+8) 後取隔天
  const cst = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  cst.setUTCDate(cst.getUTCDate() + 1);
  return cst.toISOString().slice(0, 10);
}

const targetDate = process.env.FORECAST_DATE || getTomorrowCST();
console.log(`[cron] target date: ${targetDate}`);

// ── 讀取浪點設定 ──────────────────────────────────────────────────────────────
const spots = JSON.parse(readFileSync(SPOTS_FILE, 'utf8'));
console.log(`[cron] processing ${spots.length} spots`);

// ── 處理單一浪點 ──────────────────────────────────────────────────────────────
async function processSpot(spot) {
  const outFile = path.join(DATA_DIR, `${spot.slug}.json`);
  const generatedAt = new Date().toISOString();

  // 讀取現有 JSON（保留 stale_since 原始時間）
  let existing = null;
  if (existsSync(outFile)) {
    try { existing = JSON.parse(readFileSync(outFile, 'utf8')); } catch {}
  }

  // 潮汐與海象並行抓取
  const tidesPromise = spot.tide_station
    ? fetchTides(spot.tide_station, targetDate).catch(() => null)
    : Promise.resolve(null);

  let weatherData;
  try {
    weatherData = await fetchMarineData(spot.lat, spot.lon, targetDate);
    console.log(`[${spot.slug}] marine OK — conf=${weatherData.confidence}`);
  } catch (err) {
    console.error(`[${spot.slug}] marine fetch error: ${err.message}`);
    const output = {
      spot:          spot.slug,
      name:          spot.name,
      generated_at:  generatedAt,
      date:          targetDate,
      stale:         true,
      stale_since:   existing?.stale ? existing.stale_since : generatedAt,
      stale_reason:  'open_meteo_error',
    };
    writeFileSync(outFile, JSON.stringify(output, null, 2));
    return;
  }

  // 等潮汐結果（marine 已完成，tide 可能還在跑）
  const tides = await tidesPromise;
  weatherData.tides = tides;

  // Claude
  const claude = await callClaude(weatherData, spot.name, spot.description);

  if (claude.stale) {
    console.warn(`[${spot.slug}] Claude stale — ${claude.stale_reason}`);
    const output = {
      spot:          spot.slug,
      name:          spot.name,
      generated_at:  generatedAt,
      date:          targetDate,
      stale:         true,
      stale_since:   existing?.stale ? existing.stale_since : generatedAt,
      stale_reason:  claude.stale_reason,
      // 保留上次有效資料的海象數據（供 UI 參考）
      ...(existing && !existing.stale ? {
        swell_height_m:      existing.swell_height_m,
        swell_period_s:      existing.swell_period_s,
        swell_direction_deg: existing.swell_direction_deg,
        wind_wave_height_m:  existing.wind_wave_height_m,
        wind_speed_ms:       existing.wind_speed_ms,
        wind_direction_deg:  existing.wind_direction_deg,
        best_window_start:   existing.best_window_start,
        best_window_end:     existing.best_window_end,
        confidence:          existing.confidence,
        rating:              existing.rating,
        summary:             existing.summary,
        notes:               existing.notes,
        tides:               existing.tides ?? null,
      } : {}),
    };
    writeFileSync(outFile, JSON.stringify(output, null, 2));
    return;
  }

  const output = {
    spot:                spot.slug,
    name:                spot.name,
    generated_at:        generatedAt,
    date:                targetDate,
    stale:               false,
    stale_since:         null,
    swell_height_m:      weatherData.swell_height_m,
    swell_period_s:      weatherData.swell_period_s,
    swell_direction_deg: weatherData.swell_direction_deg,
    wind_wave_height_m:  weatherData.wind_wave_height_m,
    wind_speed_ms:       weatherData.wind_speed_ms,
    wind_direction_deg:  weatherData.wind_direction_deg,
    best_window_start:   weatherData.best_window_start,
    best_window_end:     weatherData.best_window_end,
    swell_ratio:         weatherData.swell_ratio,
    wind_model_spread_ms: weatherData.wind_model_spread_ms,
    confidence:          weatherData.confidence,
    tides:               tides ?? null,
    rating:              claude.rating,
    summary:             claude.summary,
    notes:               claude.notes,
  };

  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`[${spot.slug}] ✓ rating=${claude.rating} summary="${claude.summary}"`);
}

// ── 並行跑所有浪點 ────────────────────────────────────────────────────────────
const results = await Promise.allSettled(spots.map(processSpot));

let succeeded = 0;
let failed    = 0;
results.forEach((r, i) => {
  if (r.status === 'fulfilled') {
    succeeded++;
  } else {
    failed++;
    console.error(`[${spots[i].slug}] unhandled error: ${r.reason}`);
  }
});

console.log(`\n[cron] done — ${succeeded} ok, ${failed} failed`);
if (failed > 0) process.exit(1);
