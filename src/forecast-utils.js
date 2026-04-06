/**
 * forecast-utils.js — 共用預報邏輯
 * 由 scripts/fetch-and-generate.js 與 scripts/test-prompt.js 共同引用
 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Best Window Algorithm ─────────────────────────────────────────────────────
// Input: swellHourly (array of 24 values for target date), times (ISO string array)
// Output: { start, end, indices } — indices are local (0-23 within the day)

export function computeBestWindow(swellHourly, times) {
  const vals = swellHourly.map(v => v ?? 0);
  const peakH = Math.max(...vals);

  if (peakH === 0) {
    return { start: '06:00', end: '10:00', indices: [6, 7, 8, 9] };
  }

  const threshold = peakH * 0.7;
  let windowItems = vals
    .map((h, i) => ({ h, i }))
    .filter(x => x.h >= threshold);

  if (windowItems.length === 0) {
    const peakIdx = vals.indexOf(peakH);
    windowItems = [{ h: peakH, i: peakIdx }];
  }

  // 8-hour cap centered on peak
  if (windowItems.length > 8) {
    const peakIdx = vals.indexOf(peakH);
    const half = 4;
    const rawStart = Math.max(0, peakIdx - half);
    const rawEnd = Math.min(vals.length - 1, rawStart + 7);
    windowItems = vals
      .map((h, i) => ({ h, i }))
      .filter(x => x.i >= rawStart && x.i <= rawEnd);
  }

  // Derive hour numbers
  const hourOf = localIdx => {
    const t = times[localIdx];
    if (!t) return null;
    return parseInt(t.split('T')[1]?.slice(0, 2) ?? '0', 10);
  };

  let startHour = hourOf(windowItems[0].i) ?? 6;
  let endHour   = (hourOf(windowItems[windowItems.length - 1].i) ?? 9) + 1;

  // Clamp to daylight: 04:00–22:00
  startHour = Math.max(4, startHour);
  endHour   = Math.min(22, endHour);
  if (startHour >= endHour) { startHour = 6; endHour = 10; }

  return {
    start: `${String(startHour).padStart(2, '0')}:00`,
    end:   `${String(endHour).padStart(2, '0')}:00`,
    indices: windowItems.map(x => x.i),
  };
}

// ── Confidence Scoring ────────────────────────────────────────────────────────
// Computed over best_window hours only. Returns 'high' | 'med' | 'low'.
// swell_ratio = swell_wave_height / (swell_wave_height + wind_wave_height)

export function computeConfidence({ swellPeriod, windSpeed, swellHeight, windWaveHeight, windSpread }) {
  const avg = arr => {
    const vals = (arr ?? []).filter(v => v != null && !isNaN(v));
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  const peak = arr => {
    const vals = (arr ?? []).filter(v => v != null && !isNaN(v));
    return vals.length ? Math.max(...vals) : null;
  };

  const peakPeriod   = peak(swellPeriod);
  const avgWind      = avg(windSpeed);
  const avgSwellH    = avg(swellHeight);
  const avgWindWaveH = avg(windWaveHeight);

  const swellRatio = (avgSwellH != null && avgWindWaveH != null)
    ? avgSwellH / (avgSwellH + avgWindWaveH + 0.001)
    : null;

  // Base confidence from swell quality — calibrated for Taiwan wave climate
  // (typical swell period 4–8s; 10s+ is rare and excellent)
  let confidence;
  if (peakPeriod >= 8 && avgWind < 6  && (swellRatio ?? 0) > 0.65) confidence = 'high';
  else if (peakPeriod >= 5 && avgWind < 9  && (swellRatio ?? 0) > 0.40) confidence = 'med';
  else confidence = 'low';

  // Downgrade based on inter-model wind spread (model disagreement = uncertain forecast)
  // spread > 4 m/s: models disagree strongly → force low
  // spread > 2 m/s: models disagree moderately → cap at med
  if (windSpread != null) {
    if (windSpread > 4) {
      confidence = 'low';
    } else if (windSpread > 2 && confidence === 'high') {
      confidence = 'med';
    }
  }

  return confidence;
}

// ── Inter-model Wind Spread ───────────────────────────────────────────────────
// Fetches wind_speed_10m from 3 independent models in parallel.
// Returns the max-min spread (m/s) over best-window hours, or null on failure.
// High spread = models disagree = uncertain forecast.

const WIND_MODELS = ['ecmwf_ifs025', 'gfs025', 'icon_seamless'];

async function fetchWindModelSpread(lat, lon, bwGlobalIdx) {
  const fetches = WIND_MODELS.map(model => {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude',        lat);
    url.searchParams.set('longitude',       lon);
    url.searchParams.set('hourly',          'wind_speed_10m');
    url.searchParams.set('models',          model);
    url.searchParams.set('wind_speed_unit', 'ms');
    url.searchParams.set('timezone',        'Asia/Taipei');
    url.searchParams.set('forecast_days',   '2');
    return fetch(url.toString())
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
  });

  const results = await Promise.all(fetches);

  // For each model, compute average wind speed over best-window indices
  const modelAvgs = results.map((data, mi) => {
    const speeds = data?.hourly?.wind_speed_10m;
    if (!speeds) return null;
    const vals = bwGlobalIdx.map(i => speeds[i]).filter(v => v != null && !isNaN(v));
    if (!vals.length) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }).filter(v => v != null);

  if (modelAvgs.length < 2) return null; // need at least 2 models to compute spread

  const spread = Math.max(...modelAvgs) - Math.min(...modelAvgs);
  return Math.round(spread * 10) / 10;
}

// ── Fetch Marine Data ─────────────────────────────────────────────────────────

export async function fetchMarineData(lat, lon, date) {
  const marineUrl = new URL('https://marine-api.open-meteo.com/v1/marine');
  marineUrl.searchParams.set('latitude',  lat);
  marineUrl.searchParams.set('longitude', lon);
  marineUrl.searchParams.set('hourly', [
    'wave_height', 'wave_period', 'wave_direction',
    'swell_wave_height', 'swell_wave_period', 'swell_wave_direction',
    'wind_wave_height',
  ].join(','));
  marineUrl.searchParams.set('timezone',     'Asia/Taipei');
  marineUrl.searchParams.set('forecast_days', '2');

  const windUrl = new URL('https://api.open-meteo.com/v1/forecast');
  windUrl.searchParams.set('latitude',       lat);
  windUrl.searchParams.set('longitude',      lon);
  windUrl.searchParams.set('hourly',         'wind_speed_10m,wind_direction_10m');
  windUrl.searchParams.set('wind_speed_unit', 'ms');
  windUrl.searchParams.set('timezone',        'Asia/Taipei');
  windUrl.searchParams.set('forecast_days',   '2');

  const [marineRes, windRes] = await Promise.all([
    fetch(marineUrl.toString()),
    fetch(windUrl.toString()),
  ]);

  if (!marineRes.ok) throw new Error(`Marine API ${marineRes.status}`);
  if (!windRes.ok)   throw new Error(`Wind API ${windRes.status}`);

  const [marine, wind] = await Promise.all([marineRes.json(), windRes.json()]);

  // Indices for target date (24 hours)
  let dateIndices = marine.hourly.time.reduce((acc, t, i) => {
    if (t.startsWith(date)) acc.push(i);
    return acc;
  }, []);
  if (dateIndices.length === 0) {
    // fallback: tomorrow = indices 24-47
    for (let i = 24; i < 48 && i < marine.hourly.time.length; i++) dateIndices.push(i);
  }

  // Swell array for the day (fallback to total wave_height)
  const swellH = marine.hourly.swell_wave_height ?? marine.hourly.wave_height;
  const swellHourly   = dateIndices.map(i => swellH[i] ?? null);
  const timesForDate  = dateIndices.map(i => marine.hourly.time[i]);

  // Compute best window
  const bw = computeBestWindow(swellHourly, timesForDate);

  // Map local indices back to global
  const bwGlobalIdx = bw.indices.length > 0
    ? bw.indices.map(li => dateIndices[li]).filter(i => i != null)
    : dateIndices.slice(6, 10);

  const avgOver = arr => {
    if (!arr) return null;
    const vals = bwGlobalIdx.map(i => arr[i]).filter(v => v != null);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };

  const r1 = v => v != null ? Math.round(v * 10) / 10 : null;
  const r0 = v => v != null ? Math.round(v)          : null;

  const swellPeriodArr   = marine.hourly.swell_wave_period   ?? marine.hourly.wave_period;
  const swellDirArr      = marine.hourly.swell_wave_direction ?? marine.hourly.wave_direction;
  const windWaveHArr     = marine.hourly.wind_wave_height;

  const avgSwellH        = avgOver(swellH);
  const avgWindWaveH     = avgOver(windWaveHArr);

  const swellRatio = (avgSwellH != null && avgWindWaveH != null)
    ? Math.round(avgSwellH / (avgSwellH + avgWindWaveH + 0.001) * 100) / 100
    : null;

  // Inter-model wind spread (3 models in parallel, non-blocking)
  const windSpread = await fetchWindModelSpread(lat, lon, bwGlobalIdx).catch(() => null);
  if (windSpread != null) {
    console.log(`  [spread] inter-model wind spread: ${windSpread} m/s`);
  }

  // Confidence uses best_window hour values + inter-model spread
  const confidence = computeConfidence({
    swellPeriod:    bwGlobalIdx.map(i => swellPeriodArr?.[i]),
    windSpeed:      bwGlobalIdx.map(i => wind.hourly.wind_speed_10m?.[i]),
    swellHeight:    bwGlobalIdx.map(i => swellH[i]),
    windWaveHeight: bwGlobalIdx.map(i => windWaveHArr?.[i]),
    windSpread,
  });

  return {
    date,
    swell_height_m:          r1(avgSwellH),
    swell_period_s:          r0(avgOver(swellPeriodArr)),
    swell_direction_deg:     r0(avgOver(swellDirArr)),
    wind_wave_height_m:      r1(avgWindWaveH),
    wind_speed_ms:           r1(avgOver(wind.hourly.wind_speed_10m)),
    wind_direction_deg:      r0(avgOver(wind.hourly.wind_direction_10m)),
    swell_ratio:             swellRatio,
    best_window_start:       bw.start,
    best_window_end:         bw.end,
    wind_model_spread_ms:    windSpread,
    confidence,
  };
}

// ── Fetch Tides (CWA 中央氣象署 F-A0021-001) ─────────────────────────────────
// Requires env: CWA_API_KEY (free registration at opendata.cwa.gov.tw)
// Returns array of { time: "HH:MM", type: "high"|"low", height_m: number }
// or null if API key not set / request fails (non-blocking).

export async function fetchTides(stationName, date) {
  const apiKey = process.env.CWA_API_KEY;
  if (!apiKey) {
    console.warn('[tides] CWA_API_KEY not set, skipping');
    return null;
  }

  const url = new URL('https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-A0021-001');
  url.searchParams.set('Authorization', apiKey);
  url.searchParams.set('StationName',   stationName);
  url.searchParams.set('timeFrom',      `${date}T00:00:00`);
  url.searchParams.set('timeTo',        `${date}T23:59:59`);

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`[tides] CWA ${res.status} for ${stationName}`);
      return null;
    }
    const data = await res.json();

    // F-A0021-001 response shape (may vary by API version — parse defensively)
    const forecasts = data?.result?.records?.TideForecasts ?? data?.records?.TideForecasts;
    if (!Array.isArray(forecasts) || forecasts.length === 0) {
      console.warn(`[tides] no forecast records for ${stationName}`);
      return null;
    }

    const times = forecasts[0]?.Location?.TimePeriod?.Time ?? [];
    if (!times.length) return null;

    const entries = times.map(t => {
      const dt     = t.DateTime ?? '';
      const time   = dt.length >= 16 ? dt.slice(11, 16) : null;
      const type   = t.TideRange === 'H' ? 'high' : 'low';
      const raw    = t.TideHeights?.AboveTWVD ?? t.TideHeights?.AboveChartDatum ?? null;
      const height = raw != null ? Math.round(parseFloat(raw) * 100) / 100 : null;
      return time ? { time, type, height_m: height } : null;
    }).filter(Boolean);

    console.log(`[tides] ${stationName} — ${entries.length} entries`);
    return entries.length ? entries : null;
  } catch (err) {
    console.warn(`[tides] fetch error for ${stationName}: ${err.message}`);
    return null;
  }
}

// ── Claude CLI Call ───────────────────────────────────────────────────────────
// Uses `claude --print` subprocess (reuses Claude Code CLI auth, no API key needed).
// Returns { stale, stale_reason } on failure or { stale:false, rating, summary, notes } on success.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ── Seasonal / Weather Context ────────────────────────────────────────────────
export function getSeasonalContext(dateStr) {
  const month = parseInt((dateStr || new Date().toISOString()).slice(5, 7), 10);
  if (month >= 6 && month <= 10) {
    return '【颱風季節警示（6–10月）】颱風外圍湧浪可能帶來大浪但週期短且亂，颱風本體逼近時務必禁止下水。請在 notes 中特別標注颱風相關風險。';
  }
  if (month >= 11 || month <= 3) {
    return '【東北季風季節（11–3月）】東北角與東海岸受強烈東北風影響，浪況常混亂且難以預測；南台灣（墾丁）相對穩定。請在 notes 中說明季風對此浪點的影響。';
  }
  return '【春季過渡期（4–5月）】東北季風漸弱，注意西南季風開始醞釀帶來南部湧浪。';
}

export async function callClaude(data, spotLabel, spotDesc) {
  const seasonalCtx = getSeasonalContext(data.date);

  const tideStr = (() => {
    if (!data.tides?.length) return '未取得';
    return data.tides.map(t =>
      `${t.type === 'high' ? '高潮' : '低潮'} ${t.time}${t.height_m != null ? ` (${t.height_m}m)` : ''}`
    ).join(' / ');
  })();

  const prompt = `你是台灣衝浪預報助理。你的回覆必須只包含 JSON，不可有任何說明文字或 markdown。

${seasonalCtx}

請根據以下明天 ${spotLabel} 的海象預報，給出衝浪建議。

浪點簡介：${spotDesc}
日期：${data.date}（台灣時間）

海象數據（最佳衝浪時窗 ${data.best_window_start}–${data.best_window_end}）：
- 湧浪高度：${data.swell_height_m} 公尺
- 湧浪週期：${data.swell_period_s} 秒（方向 ${data.swell_direction_deg}°）
- 風浪高度：${data.wind_wave_height_m} 公尺
- 平均風速：${data.wind_speed_ms} m/s（方向 ${data.wind_direction_deg}°）
- 湧浪純淨比：${data.swell_ratio != null ? Math.round(data.swell_ratio * 100) + '%（越高越乾淨）' : '未知'}
- 模型預報共識：${data.wind_model_spread_ms != null ? `各模型風速差 ${data.wind_model_spread_ms} m/s（>4 表示預報不確定）` : '未取得'}
- 數據信心度（供參考，請反映在建議中）：${data.confidence}
- 潮汐：${tideStr}

請輸出 JSON，不要有任何說明文字或 markdown：
{
  "rating": 整數 1-5,
  "summary": "最多 20 個字的衝浪建議",
  "notes": "注意事項，包含季節/颱風/季風提醒（如無則輸出 null）"
}`;

  let stdout;
  try {
    const result = await execFileAsync('claude', [
      '--print', prompt,
      '--output-format', 'json',
      '--disallowed-tools', 'Bash,Edit,Write,Read,Glob,Grep,Agent',
    ], { timeout: 60_000 });
    stdout = result.stdout;
  } catch (err) {
    console.error('[Claude CLI] error:', err.message?.slice(0, 200));
    return { stale: true, stale_reason: 'cli_error' };
  }

  // Parse the CLI JSON envelope
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    console.error('[Claude CLI] envelope parse failed:', stdout?.slice(0, 200));
    return { stale: true, stale_reason: 'envelope_parse_error' };
  }

  if (envelope.type !== 'result' || envelope.subtype !== 'success') {
    console.error('[Claude CLI] unexpected result:', envelope.type, envelope.subtype);
    return { stale: true, stale_reason: `cli_${envelope.subtype ?? 'unknown'}` };
  }

  const resultText = envelope.result ?? '';

  // Extract JSON (may be wrapped in markdown code fences)
  const jsonMatch = resultText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('[Claude CLI] no JSON in result:', resultText.slice(0, 200));
    return { stale: true, stale_reason: 'json_parse_error' };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.error('[Claude CLI] JSON parse failed:', resultText.slice(0, 200));
    return { stale: true, stale_reason: 'json_parse_error' };
  }

  const rating  = parsed.rating;
  const summary = parsed.summary ?? '';
  const notes   = parsed.notes   ?? null;
  const sumLen  = [...summary].length;
  const noteLen = notes ? [...notes].length : 0;

  return {
    stale:   false,
    rating:  Math.max(1, Math.min(5, Number.isInteger(rating) ? rating : 3)),
    summary: sumLen  > 20 ? [...summary].slice(0, 20).join('') : summary,
    notes:   noteLen > 60 ? [...notes].slice(0, 60).join('')   : notes,
  };
}
