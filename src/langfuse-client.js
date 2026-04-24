/**
 * langfuse-client.js — Langfuse 雲端版觀測性客戶端
 *
 * 若 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 未設定，回傳 no-op stub，
 * 讓其餘程式碼不用判斷啟用與否。
 */
import { Langfuse } from 'langfuse';

const noopGeneration = {
  update() {},
  end() {},
};

const noopClient = {
  enabled: false,
  generation: () => noopGeneration,
  trace: () => ({ update() {}, generation: () => noopGeneration, end() {} }),
  flushAsync: async () => {},
  shutdownAsync: async () => {},
};

function buildClient() {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    console.log('[langfuse] 未設定 key，觀測性關閉');
    return noopClient;
  }
  const baseUrl = process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com';
  const client = new Langfuse({ publicKey, secretKey, baseUrl });
  client.enabled = true;
  console.log(`[langfuse] 已啟用 → ${baseUrl}`);
  return client;
}

export const langfuse = buildClient();

/**
 * 將任何 askClaude-style 函式包上 generation trace。
 * 失敗也會 end()，確保 span 不漏出。
 */
export async function traceGeneration(name, prompt, fn, meta = {}) {
  if (!langfuse.enabled) return fn();

  const generation = langfuse.generation({
    name,
    model: meta.model || 'claude-cli',
    input: prompt,
    metadata: meta,
  });
  try {
    const output = await fn();
    generation.end({ output });
    return output;
  } catch (err) {
    generation.end({ output: null, level: 'ERROR', statusMessage: err.message });
    throw err;
  }
}
