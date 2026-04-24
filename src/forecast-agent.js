/**
 * forecast-agent.js — 單一浪點預報 Agent
 *
 * 用 Claude Agent SDK 串接 mcp-server，取代原本的 callClaude() subprocess。
 * Agent 自己負責：fetch 數據 → 評估 → save JSON。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER    = path.join(__dirname, 'mcp-server.js');

const SYSTEM_PROMPT = `你是台灣衝浪預報助理，專門根據客觀海象數據評估浪況。

評估標準：
- 湧浪高度 < 0.5m：太小，rating 1
- 湧浪高度 0.5–1.0m：初學者，rating 2–3
- 湧浪高度 1.0–1.5m：中級，rating 3–4
- 湧浪高度 1.5–2.5m：進階，rating 4–5
- 湧浪高度 > 2.5m：高手，rating 5（但需注意安全）
- 週期 > 10s：湧浪品質佳（+1）
- 風速 > 9 m/s：浪面雜亂（-1）
- 信心度 low：預報不確定，在 notes 中說明
- 季節上下文：颱風季/東北季風季/春季過渡期的影響要反映在 notes

工作流程：
1. 呼叫 fetch_spot_forecast_data 取得海象與潮汐數據
2. 根據數據評估 rating（1–5）、summary（最多 20 字）、notes（注意事項，可 null）
3. 呼叫 save_spot_forecast 儲存結果（weather_data 傳入 fetch 回傳的完整 JSON 字串）

重要：summary 不得超過 20 個中文字，notes 不得超過 60 個中文字。`;

/**
 * 為單一浪點執行預報 Agent
 * @param {object} spot - { slug, name, lat, lon, tide_station?, description? }
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<{ ok: boolean, rating?: number, summary?: string, error?: string }>}
 */
export async function runForecastAgent(spot, date) {
  const mcpServers = {
    'surf-forecast': { command: 'node', args: [MCP_SERVER] },
  };

  const prompt = `請為以下浪點生成 ${date} 的衝浪預報：

浪點：${spot.name}（${spot.slug}）
座標：lat=${spot.lat}, lon=${spot.lon}
潮汐站：${spot.tide_station ?? '無'}
浪點說明：${spot.description ?? ''}

請依序：
1. 呼叫 fetch_spot_forecast_data（lat=${spot.lat}, lon=${spot.lon}, date="${date}"${spot.tide_station ? `, tide_station="${spot.tide_station}"` : ''}, spot_name="${spot.name}"）
2. 評估並決定 rating、summary、notes
3. 呼叫 save_spot_forecast（slug="${spot.slug}", name="${spot.name}", date="${date}", rating=<你的評級>, summary=<建議>, notes=<注意事項或null>, weather_data=<fetch回傳的完整JSON字串>）`;

  try {
    for await (const message of query({
      prompt,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        mcpServers,
        maxTurns:       15,
        permissionMode: 'bypassPermissions',
      },
    })) {
      if ('result' in message) {
        return { ok: true };
      }
    }
    return { ok: false, error: 'agent ended without result' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
