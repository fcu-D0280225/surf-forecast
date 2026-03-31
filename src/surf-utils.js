/**
 * surf-utils.js — 共用函式（geocode + 氣象 API）
 * 由 mcp-server.js 與 web-server.js 共同引用
 */

export const TW_SPOTS = {
  '墾丁':   { latitude: 21.9389, longitude: 120.8408, name: '墾丁' },
  '南灣':   { latitude: 21.9389, longitude: 120.8408, name: '南灣, 墾丁' },
  '台東':   { latitude: 22.7583, longitude: 121.1444, name: '台東' },
  '東河':   { latitude: 23.1167, longitude: 121.3667, name: '東河, 台東' },
  '宜蘭':   { latitude: 24.7021, longitude: 121.7378, name: '宜蘭' },
  '大溪':   { latitude: 24.8833, longitude: 121.9000, name: '大溪, 宜蘭' },
  '旗津':   { latitude: 22.6167, longitude: 120.2667, name: '旗津, 高雄' },
  '花蓮':   { latitude: 23.9833, longitude: 121.6000, name: '花蓮' },
  '成功':   { latitude: 23.0992, longitude: 121.3742, name: '成功, 台東' },
  '鹽寮':   { latitude: 24.0167, longitude: 121.6333, name: '鹽寮, 花蓮' },
  '松柏港': { latitude: 23.6000, longitude: 119.9000, name: '松柏港' },
};

export async function geocode(location) {
  for (const [key, spot] of Object.entries(TW_SPOTS)) {
    if (location.includes(key)) return { ...spot, country: '台灣' };
  }
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=5&language=zh&format=json`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.results?.length) throw new Error(`找不到地點：${location}`);
  const tw = data.results.find(r => r.country_code === 'TW') ?? data.results[0];
  return { latitude: tw.latitude, longitude: tw.longitude, name: tw.name, country: tw.country };
}

export function degreesToDirection(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round((deg ?? 0) / 22.5) % 16];
}

function weatherCodeToText(code) {
  if (code == null) return null;
  if (code === 0)           return '晴';
  if (code <= 3)            return '多雲';
  if (code <= 48)           return '陰/霧';
  if (code <= 67)           return '雨';
  if (code <= 77)           return '雪';
  if (code <= 82)           return '陣雨';
  return '雷雨';
}

const avg  = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((s,x) => s+x, 0)/v.length : null; };
const r1   = v => v != null ? Math.round(v * 10) / 10 : null;
const r0   = v => v != null ? Math.round(v) : null;

function extractMorningConditions(marine, wind) {
  const h = marine.hourly;
  const w = wind.hourly;
  const s = arr => arr?.slice(6, 13) ?? [];
  const windDir = avg(s(w.wind_direction_10m));
  const waveDir = avg(s(h.wave_direction));
  const weatherCode = s(w.weather_code).find(v => v != null) ?? null;
  return {
    wave_height_m:        r1(avg(s(h.wave_height))),
    wave_period_s:        r0(avg(s(h.wave_period))),
    swell_height_m:       r1(avg(s(h.swell_wave_height))),
    swell_period_s:       r0(avg(s(h.swell_wave_period))),
    wind_speed_kmh:       r0(avg(s(w.wind_speed_10m))),
    wind_direction_deg:   r0(windDir),
    wind_direction_text:  windDir != null ? degreesToDirection(windDir) : null,
    wave_direction_deg:   r0(waveDir),
    wave_direction_text:  waveDir != null ? degreesToDirection(waveDir) : null,
    water_temp_c:         r1(avg(s(h.sea_surface_temperature))),
    weather_text:         weatherCodeToText(weatherCode),
  };
}

function extractConditionsForDate(marine, wind, dateIso) {
  const idxs = marine.hourly.time.reduce((acc, t, i) => {
    if (!t.startsWith(dateIso)) return acc;
    const hr = parseInt(t.split('T')[1]);
    if (hr >= 6 && hr <= 12) acc.push(i);
    return acc;
  }, []);
  if (!idxs.length) return null;
  const pick  = arr => idxs.map(i => arr?.[i]).filter(v => v != null);
  const pickW = key => idxs.map(i => wind.hourly[key]?.[i]).filter(v => v != null);
  const windDir = avg(pickW('wind_direction_10m'));
  const waveDir = avg(pick(marine.hourly.wave_direction));
  const weatherCode = pickW('weather_code').find(v => v != null) ?? null;
  return {
    wave_height_m:        r1(avg(pick(marine.hourly.wave_height))),
    wave_period_s:        r0(avg(pick(marine.hourly.wave_period))),
    swell_height_m:       r1(avg(pick(marine.hourly.swell_wave_height))),
    swell_period_s:       r0(avg(pick(marine.hourly.swell_wave_period))),
    wind_speed_kmh:       r0(avg(pickW('wind_speed_10m'))),
    wind_direction_deg:   r0(windDir),
    wind_direction_text:  windDir != null ? degreesToDirection(windDir) : null,
    wave_direction_deg:   r0(waveDir),
    wave_direction_text:  waveDir != null ? degreesToDirection(waveDir) : null,
    water_temp_c:         r1(avg(pick(marine.hourly.sea_surface_temperature))),
    weather_text:         weatherCodeToText(weatherCode),
  };
}

async function fetchHistoricalMarine(lat, lon, dateIso) {
  const url = new URL('https://marine-api.open-meteo.com/v1/marine');
  url.searchParams.set('latitude', lat); url.searchParams.set('longitude', lon);
  url.searchParams.set('hourly', 'wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,sea_surface_temperature');
  url.searchParams.set('start_date', dateIso); url.searchParams.set('end_date', dateIso);
  url.searchParams.set('timezone', 'Asia/Taipei');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Marine 歷史 API 錯誤：${res.status}`);
  return res.json();
}

async function fetchHistoricalWind(lat, lon, dateIso) {
  const url = new URL('https://archive-api.open-meteo.com/v1/archive');
  url.searchParams.set('latitude', lat); url.searchParams.set('longitude', lon);
  url.searchParams.set('hourly', 'wind_speed_10m,wind_direction_10m,weather_code');
  url.searchParams.set('start_date', dateIso); url.searchParams.set('end_date', dateIso);
  url.searchParams.set('timezone', 'Asia/Taipei');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Wind 歷史 API 錯誤：${res.status}`);
  return res.json();
}

export async function fetchSurfForecast(lat, lon, forecastDays = 7) {
  const url = new URL('https://marine-api.open-meteo.com/v1/marine');
  url.searchParams.set('latitude', lat); url.searchParams.set('longitude', lon);
  url.searchParams.set('hourly', 'wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,wind_wave_height,sea_surface_temperature');
  url.searchParams.set('daily', 'wave_height_max,wave_period_max,swell_wave_height_max');
  url.searchParams.set('forecast_days', forecastDays);
  url.searchParams.set('timezone', 'Asia/Taipei');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Marine API 錯誤：${res.status}`);
  return res.json();
}

export async function fetchWindForecast(lat, lon, forecastDays = 7) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat); url.searchParams.set('longitude', lon);
  url.searchParams.set('hourly', 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code');
  url.searchParams.set('forecast_days', forecastDays);
  url.searchParams.set('timezone', 'Asia/Taipei');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Wind API 錯誤：${res.status}`);
  return res.json();
}

/**
 * 統一取得某日客觀條件（自動判斷過去 / 未來）
 * @returns {{ conditions, source: 'historical'|'forecast' }}
 */
export async function fetchConditionsForDate(lat, lon, dateIso) {
  const target = new Date(dateIso + 'T00:00:00+08:00');
  const today  = new Date(); today.setHours(0, 0, 0, 0);
  const isPast = target < today;

  if (isPast) {
    const [marine, wind] = await Promise.all([
      fetchHistoricalMarine(lat, lon, dateIso),
      fetchHistoricalWind(lat, lon, dateIso),
    ]);
    return { conditions: extractMorningConditions(marine, wind), source: 'historical' };
  }

  const daysAhead = Math.ceil((target - today) / 86400000) + 1;
  if (daysAhead > 7) throw new Error('預報最多支援未來 7 天');
  const [marine, wind] = await Promise.all([
    fetchSurfForecast(lat, lon, daysAhead + 1),
    fetchWindForecast(lat, lon, daysAhead + 1),
  ]);
  const conditions = extractConditionsForDate(marine, wind, dateIso);
  if (!conditions) throw new Error(`找不到 ${dateIso} 的預報資料`);
  return { conditions, source: 'forecast' };
}
