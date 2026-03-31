/**
 * index.js — Surf Forecast CLI
 * 用 Claude Agent SDK 串 MCP server 回答浪況問題
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(__dirname, 'mcp-server.js');

const SYSTEM_PROMPT = `你是一位專業的衝浪教練，擅長分析海況並給出建議。

當使用者詢問浪況時：
1. 使用 get_surf_forecast 工具取得即時資料
2. 若使用者要「記錄某一天浪況好不好／心得」，使用 record_surf_log
   → 系統會自動從 Open-Meteo 抓該天客觀數據（浪高、週期、風力、風向），不需手動輸入
3. 若使用者問過去衝過的紀錄、想回顧某類浪況，使用 search_surf_logs
4. 若使用者問「X 天後適合衝浪嗎」或「預測某日浪況」，使用 predict_surf_day
   → 工具會抓預報條件，並從歷史紀錄找相似天的評價，輔助預測
   → 根據 similar_historical_days 的 rating 分布給出預測結論
5. 用繁體中文分析並解釋浪況
6. 給出具體建議：適不適合衝浪、適合哪種程度的衝浪者
7. 說明浪高、週期、湧浪方向、風況對衝浪的影響

評估標準：
- 浪高 < 0.5m：太小，不適合
- 浪高 0.5–1.0m：適合初學者
- 浪高 1.0–1.5m：適合中級
- 浪高 1.5–2.5m：適合進階
- 浪高 > 2.5m：僅適合高手
- 週期 > 10 秒：湧浪品質佳
- 風速 < 20 km/h：適合衝浪
- 離岸風（offshore）：讓浪面更整齊，最佳
- 向岸風（onshore）：浪面雜亂，品質差

所有回覆請使用繁體中文。`;

const mcpServers = {
  'surf-forecast': {
    command: 'node',
    args: [MCP_SERVER_PATH],
  },
};

async function askSurf(question) {
  console.log('\n🌊 分析中...\n');
  let result = '';

  for await (const message of query({
    prompt: question,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      mcpServers,
      maxTurns: 5,
      permissionMode: 'bypassPermissions',
    },
  })) {
    if ('result' in message) {
      result = message.result;
    }
  }

  return result;
}

// CLI 互動介面
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('🏄 台灣浪況助手');
console.log('輸入地點和問題，例如：「墾丁今天適合衝浪嗎？」');
console.log('輸入 exit 離開\n');

function prompt() {
  rl.question('你: ', async (input) => {
    const question = input.trim();

    if (question.toLowerCase() === 'exit') {
      console.log('掰掰！好好衝浪 🤙');
      rl.close();
      return;
    }

    if (!question) {
      prompt();
      return;
    }

    try {
      const answer = await askSurf(question);
      console.log(`\n助手: ${answer}\n`);
    } catch (err) {
      console.error(`\n錯誤：${err.message}\n`);
    }

    prompt();
  });
}

prompt();
