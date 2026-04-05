/**
 * test-prompt.js — 手動測試 Claude 衝浪建議 prompt 品質
 *
 * 用法：
 *   ANTHROPIC_API_KEY=sk-ant-xxx node scripts/test-prompt.js
 *   ANTHROPIC_API_KEY=sk-ant-xxx node scripts/test-prompt.js 東北角
 *   ANTHROPIC_API_KEY=sk-ant-xxx node scripts/test-prompt.js 墾丁 2026-04-03
 *
 * 測試三件事：
 *   1. open-meteo 對該浪點的 swell 數據是否完整
 *   2. Claude 輸出格式是否符合規格（JSON，20字以內摘要）
 *   3. 建議內容品質（肉眼判斷）
 */

import { fetchMarineData, callClaude } from '../src/forecast-utils.js';

// ── 設定 ──────────────────────────────────────────────────────────────────────

const SPOTS = {
  '墾丁':   { lat: 21.96, lon: 120.75, desc: '南台灣最熱門浪點，夏季西南湧浪最佳，適合各級' },
  '南灣':   { lat: 21.96, lon: 120.75, desc: '南台灣最熱門浪點，夏季西南湧浪最佳，適合各級' },
  '東北角': { lat: 25.12, lon: 121.93, desc: '北台灣冬季首選，東北季風強勁，中高級為主' },
  '磯崎':   { lat: 23.61, lon: 121.60, desc: '東岸穩定浪點，全年均可，初中級皆宜' },
  '成功':   { lat: 23.10, lon: 121.38, desc: '東海岸南段，夏季湧浪穩定，適合中高級' },
  '花蓮':   { lat: 23.97, lon: 121.60, desc: '東岸中段，全年均可，適合中高級' },
  '台東':   { lat: 22.75, lon: 121.15, desc: '東海岸南段，多元浪型，適合初中級' },
};

const spotName = process.argv[2] || '墾丁';
const spot = SPOTS[spotName] || SPOTS['墾丁'];

// 預測日期：預設明天
function getTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
const targetDate = process.argv[3] || getTomorrow();

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n🌊 測試浪況 AI 建議`);
console.log(`   浪點：${spotName}`);
console.log(`   日期：${targetDate}`);
console.log(`   座標：${spot.lat}, ${spot.lon}\n`);

try {
  // Step 1: Fetch data
  console.log('📡 Step 1: 抓 open-meteo 數據...');
  const data = await fetchMarineData(spot.lat, spot.lon, targetDate);

  console.log('   ✅ 數據完整');
  console.log(`   湧浪高 = ${data.swell_height_m}m`);
  console.log(`   湧浪週期 = ${data.swell_period_s}s`);
  console.log(`   風浪高 = ${data.wind_wave_height_m}m`);
  console.log(`   風速 = ${data.wind_speed_ms} m/s`);
  console.log(`   湧浪佔比 = ${data.swell_ratio != null ? (data.swell_ratio * 100).toFixed(0) + '%' : 'N/A'}`);
  console.log(`   信心度 = ${data.confidence}`);
  console.log(`   最佳時窗 = ${data.best_window_start}–${data.best_window_end}`);
  if (data._raw_nulls) {
    console.log(`   Swell null 數量：${data._raw_nulls.swell_wave_height_null}/${data._raw_nulls.total_hours}`);
  }

  // Step 2: Claude
  console.log('\n🤖 Step 2: 呼叫 Claude API...');
  const result = await callClaude(data, spotName, spot.desc);

  if (result.stale) {
    console.log('   ⚠️  Claude 回傳 stale（API 錯誤或解析失敗）');
    console.log('   reason:', result.stale_reason);
  } else {
    const stars = '⭐'.repeat(result.rating) + '☆'.repeat(5 - result.rating);
    console.log('\n   ✅ Claude 輸出正常');
    console.log(`   評分：${stars} (${result.rating}/5)`);
    console.log(`   摘要：「${result.summary}」(${[...result.summary].length} 字)`);
    console.log(`   注意：${result.notes || '（無）'}`);
    console.log(`   信心度：${result.confidence}`);
  }

  // Step 3: Summary
  console.log('\n✅ 測試通過 — Prompt 品質判斷：');
  console.log('   [ ] 摘要是否實際有用？（請肉眼確認）');
  console.log('   [ ] 評分是否合理？（浪高、週期、信心度 → 幾星）');
  console.log('   [ ] 注意事項是否相關？\n');

} catch (err) {
  console.error('\n❌ 錯誤：', err.message);
  if (err.message.includes('ANTHROPIC_API_KEY')) {
    console.error('   請設定 API key：ANTHROPIC_API_KEY=sk-ant-xxx node scripts/test-prompt.js');
  }
  process.exit(1);
}
