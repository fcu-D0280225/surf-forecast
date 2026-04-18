/**
 * mcp-server.js — Surf Forecast MCP Server v2
 * 新增：record_surf_log 自動抓客觀數據、predict_surf_day 預測工具
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { geocode, fetchConditionsForDate, fetchSurfForecast, fetchWindForecast } from './surf-utils.js';

const RAG_DB_PATH = `mysql://${process.env.MYSQL_HOST || 'localhost'}/${process.env.MYSQL_DATABASE || 'surf_forecast'}`;

const server = new McpServer({ name: 'surf-forecast', version: '2.0.0' });

/** 格式化目前預報（既有功能，未來 24h 摘要） */
function formatForecast(marine, wind, locationName) {
  const now = new Date();
  const hours = marine.hourly.time;
  const startIdx = hours.findIndex(t => new Date(t) >= now);
  const endIdx = Math.min(startIdx + 24, hours.length);
  const slice = (arr) => arr.slice(startIdx, endIdx);

  const times      = slice(hours);
  const waveH      = slice(marine.hourly.wave_height);
  const wavePeriod = slice(marine.hourly.wave_period);
  const waveDir    = slice(marine.hourly.wave_direction);
  const swellH     = slice(marine.hourly.swell_wave_height);
  const swellP     = slice(marine.hourly.swell_wave_period);
  const windSpeed  = slice(wind.hourly.wind_speed_10m);
  const windGusts  = slice(wind.hourly.wind_gusts_10m);

  const summary = [];
  for (let i = 0; i < times.length; i += 6) {
    summary.push({
      time: times[i],
      wave_height_m:       waveH[i],
      wave_period_s:       wavePeriod[i],
      wave_direction_deg:  waveDir[i],
      swell_height_m:      swellH[i],
      swell_period_s:      swellP[i],
      wind_speed_kmh:      windSpeed[i],
      wind_gusts_kmh:      windGusts[i],
    });
  }

  return {
    location: locationName,
    forecast_summary: summary,
    daily_max: {
      dates:               marine.daily.time,
      wave_height_max_m:   marine.daily.wave_height_max,
      wave_period_max_s:   marine.daily.wave_period_max,
      swell_height_max_m:  marine.daily.swell_wave_height_max,
    },
  };
}

/** 將條件物件轉成搜尋 query 字串（讓 embedding 找出類似歷史紀錄） */
function conditionsToQuery(conditions, spot = '') {
  const {
    wave_height_m, swell_height_m, wave_period_s,
    wind_speed_kmh, wind_direction_text,
    wave_direction_text, water_temp_c, weather_text,
  } = conditions;
  return [
    spot ? `地點:${spot}` : '',
    wave_height_m     != null ? `浪高:${wave_height_m.toFixed(1)}m`      : '',
    swell_height_m    != null ? `湧浪:${swell_height_m.toFixed(1)}m`     : '',
    wave_period_s     != null ? `週期:${Math.round(wave_period_s)}s`      : '',
    wave_direction_text       ? `浪向:${wave_direction_text}`             : '',
    wind_speed_kmh    != null ? `風速:${Math.round(wind_speed_kmh)}km/h` : '',
    wind_direction_text       ? `風向:${wind_direction_text}`             : '',
    water_temp_c      != null ? `水溫:${water_temp_c.toFixed(1)}°C`      : '',
    weather_text              ? `天氣:${weather_text}`                    : '',
  ].filter(Boolean).join(' ');
}

// ── MCP Tools ─────────────────────────────────────────────────────────────────

server.tool(
  'get_surf_forecast',
  '取得指定地點的浪況與海象預報（浪高、週期、湧浪、風況）',
  { location: z.string().describe('地點名稱，例如：墾丁、台東、宜蘭大溪') },
  async ({ location }) => {
    const geo = await geocode(location);
    const [marine, wind] = await Promise.all([
      fetchSurfForecast(geo.latitude, geo.longitude),
      fetchWindForecast(geo.latitude, geo.longitude),
    ]);
    const result = formatForecast(marine, wind, `${geo.name}, ${geo.country}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

const DATE_ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期請用 YYYY-MM-DD');

server.tool(
  'record_surf_log',
  `記錄某天的衝浪心得，並自動從 Open-Meteo 抓當天客觀浪況數據（浪高、週期、風力、風向）寫入 RAG（${RAG_DB_PATH}）。`,
  {
    date:               DATE_ISO.describe('紀錄日期，例：2026-03-24'),
    location:           z.string().describe('浪點或地名'),
    experience_rating:  z.enum(['好', '普通', '不好']).describe('當天主觀感受'),
    notes:              z.string().optional().describe('補充：人數、板型、個人感受等'),
  },
  async ({ date, location, experience_rating, notes }) => {
    const { recordSurfLog } = await import('./rag/store.js');
    const geo = await geocode(location);
    const spotName = `${geo.name}（${geo.country}）`;

    // 自動抓客觀數據，失敗不阻擋寫入
    let conditions = {};
    let dataSource = 'none';
    try {
      const fetched = await fetchConditionsForDate(geo.latitude, geo.longitude, date);
      conditions = fetched.conditions;
      dataSource = fetched.source;
    } catch (e) {
      console.error(`[record] 無法取得客觀數據：${e.message}`);
    }

    const row = await recordSurfLog({
      dateIso: date,
      spot:    spotName,
      rating:  experience_rating,
      notes:   notes ?? '',
      conditions,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          id: row.id,
          stored_content: row.content,
          conditions_fetched: conditions,
          data_source: dataSource,
          db_path: RAG_DB_PATH,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'search_surf_logs',
  '以自然語言搜尋過去紀錄的浪況日誌（向量相似度）',
  {
    query:  z.string().describe('想回顧的主題，例如：「過去墾丁浪好的日子」'),
    top_k:  z.number().int().min(1).max(20).optional().describe('回傳筆數，預設 5'),
  },
  async ({ query, top_k }) => {
    const { searchSurfLogs } = await import('./rag/store.js');
    const hits = await searchSurfLogs({ query, topK: top_k ?? 5 });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: hits.length, results: hits, db_path: RAG_DB_PATH }, null, 2),
      }],
    };
  },
);

server.tool(
  'predict_surf_day',
  '輸入未來日期與地點，根據預報條件在歷史紀錄中找相似天，預測浪況好壞與建議',
  {
    date:     DATE_ISO.describe('預測日期，例：2026-04-05（最多 7 天內）'),
    location: z.string().describe('地點名稱'),
  },
  async ({ date, location }) => {
    const { searchSurfLogs } = await import('./rag/store.js');
    const geo = await geocode(location);
    const spotName = `${geo.name}（${geo.country ?? '台灣'}）`;

    // 取得該日預報條件
    let forecastConditions;
    try {
      const fetched = await fetchConditionsForDate(geo.latitude, geo.longitude, date);
      forecastConditions = fetched.conditions;
    } catch (e) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `無法取得 ${date} 預報：${e.message}` }, null, 2),
        }],
      };
    }

    // 用預報條件建構搜尋 query，找歷史相似紀錄
    const query = conditionsToQuery(forecastConditions, spotName);
    const similarDays = await searchSurfLogs({ query, topK: 5 });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          predict_for: { date, location: spotName },
          forecast_conditions: forecastConditions,
          rag_query_used: query,
          similar_historical_days: similarDays,
          note: '請根據 forecast_conditions 與 similar_historical_days 的 rating 分布，給出預測結論與衝浪建議。',
        }, null, 2),
      }],
    };
  },
);

// ── 啟動 ──────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
