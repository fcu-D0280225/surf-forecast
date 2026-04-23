#!/usr/bin/env node
/**
 * run-forecast-agent.js — 用 Agent 更新所有浪點預報
 *
 * 用法：
 *   node scripts/run-forecast-agent.js
 *   FORECAST_DATE=2026-04-25 node scripts/run-forecast-agent.js
 *   SPOT=kenting-nanwan node scripts/run-forecast-agent.js   # 單一浪點
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { runForecastAgent } from '../src/forecast-agent.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const SPOTS_FILE = path.join(__dirname, '..', 'public', 'spots.json');

function getTomorrowCST() {
  const cst = new Date(Date.now() + 8 * 3600_000);
  cst.setUTCDate(cst.getUTCDate() + 1);
  return cst.toISOString().slice(0, 10);
}

const targetDate = process.env.FORECAST_DATE || getTomorrowCST();
const spotFilter = process.env.SPOT || null;

let spots = JSON.parse(readFileSync(SPOTS_FILE, 'utf8'));
if (spotFilter) spots = spots.filter(s => s.slug === spotFilter);

console.log(`[forecast-agent] date: ${targetDate}, spots: ${spots.length}`);
if (spotFilter && spots.length === 0) {
  console.error(`[forecast-agent] 找不到浪點 "${spotFilter}"`);
  process.exit(1);
}

// 並行跑所有浪點（同 fetch-and-generate.js 做法）
const results = await Promise.allSettled(
  spots.map(async spot => {
    console.log(`[${spot.slug}] 開始...`);
    const r = await runForecastAgent(spot, targetDate);
    if (r.ok) {
      console.log(`[${spot.slug}] ✓`);
    } else {
      console.error(`[${spot.slug}] ✗ ${r.error}`);
      throw new Error(r.error);
    }
  }),
);

const succeeded = results.filter(r => r.status === 'fulfilled').length;
const failed    = results.filter(r => r.status === 'rejected').length;

console.log(`\n[forecast-agent] 完成 — ${succeeded} 成功, ${failed} 失敗`);
if (failed > 0) process.exit(1);
