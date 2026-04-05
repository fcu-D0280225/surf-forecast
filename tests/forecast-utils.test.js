import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeBestWindow, computeConfidence, callClaude } from '../src/forecast-utils.js';

// ── computeBestWindow ─────────────────────────────────────────────────────────

describe('computeBestWindow', () => {
  // Build a times array for 2026-04-02 (24 hours)
  const times = Array.from({ length: 24 }, (_, i) =>
    `2026-04-02T${String(i).padStart(2, '0')}:00`
  );

  it('normal swell — returns correct start/end', () => {
    const swell = Array(24).fill(0.5);
    swell[7] = 1.2;
    swell[8] = 1.5;
    swell[9] = 1.3;
    const { start, end } = computeBestWindow(swell, times);
    expect(start).toMatch(/^\d{2}:00$/);
    expect(end).toMatch(/^\d{2}:00$/);
    expect(parseInt(end) > parseInt(start)).toBe(true);
  });

  it('all zeros — fallback to 06:00–10:00', () => {
    const { start, end } = computeBestWindow(Array(24).fill(0), times);
    expect(start).toBe('06:00');
    expect(end).toBe('10:00');
  });

  it('window > 8 hours — caps to 8h centered on peak', () => {
    // peak at hour 12, all hours above threshold
    const swell = Array(24).fill(1.0);
    swell[12] = 2.0;
    const { start, end } = computeBestWindow(swell, times);
    const duration = parseInt(end) - parseInt(start);
    expect(duration).toBeLessThanOrEqual(8);
  });

  it('peak at 22:00 — end clamped to 22:00 (no midnight cross)', () => {
    const swell = Array(24).fill(0);
    swell[21] = 2.0;
    swell[22] = 2.0;
    swell[23] = 1.8;
    const { end } = computeBestWindow(swell, times);
    expect(parseInt(end)).toBeLessThanOrEqual(22);
  });

  it('peak at 03:00 — start clamped to 04:00', () => {
    const swell = Array(24).fill(0);
    swell[2] = 2.0;
    swell[3] = 1.8;
    const { start } = computeBestWindow(swell, times);
    expect(parseInt(start)).toBeGreaterThanOrEqual(4);
  });
});

// ── computeConfidence ─────────────────────────────────────────────────────────

describe('computeConfidence', () => {
  it('high: period≥10, wind<6, ratio>0.7', () => {
    expect(computeConfidence({
      swellPeriod:    [10, 11],
      windSpeed:      [4, 5],
      swellHeight:    [1.5, 1.6],
      windWaveHeight: [0.3, 0.3],
    })).toBe('high');
  });

  it('boundary: period=10, wind=6.0 → med (not high, wind must be < 6)', () => {
    expect(computeConfidence({
      swellPeriod:    [10],
      windSpeed:      [6.0],
      swellHeight:    [1.5],
      windWaveHeight: [0.2],
    })).toBe('med');
  });

  it('med: period≥7, wind<10, ratio>0.5', () => {
    expect(computeConfidence({
      swellPeriod:    [7, 8],
      windSpeed:      [7, 8],
      swellHeight:    [0.8, 0.9],
      windWaveHeight: [0.5, 0.6],
    })).toBe('med');
  });

  it('low: period<7', () => {
    expect(computeConfidence({
      swellPeriod:    [5, 6],
      windSpeed:      [3],
      swellHeight:    [0.5],
      windWaveHeight: [0.1],
    })).toBe('low');
  });

  it('handles nulls gracefully', () => {
    const result = computeConfidence({
      swellPeriod:    [null, 6],
      windSpeed:      [null],
      swellHeight:    [null],
      windWaveHeight: [null],
    });
    expect(['high', 'med', 'low']).toContain(result);
  });
});

// ── callClaude ────────────────────────────────────────────────────────────────

describe('callClaude', () => {
  const mockData = {
    date: '2026-04-02',
    swell_height_m: 1.2,
    swell_period_s: 10,
    swell_direction_deg: 180,
    wind_wave_height_m: 0.3,
    wind_speed_ms: 4.0,
    wind_direction_deg: 45,
    best_window_start: '07:00',
    best_window_end: '11:00',
    confidence: 'high',
  };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('happy path — returns rating, summary, notes', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ text: '{"rating":4,"summary":"浪況良好適合衝浪","notes":"注意離岸流"}' }],
      }),
    });
    const result = await callClaude(mockData, '墾丁南灣', '南台灣最熱門浪點');
    expect(result.stale).toBe(false);
    expect(result.rating).toBe(4);
    expect(result.summary).toBe('浪況良好適合衝浪');
    expect(result.notes).toBe('注意離岸流');
  });

  it('HTTP 429 — returns stale immediately, no retry', async () => {
    fetch.mockResolvedValue({ ok: false, status: 429 });
    const result = await callClaude(mockData, '墾丁', 'desc');
    expect(result.stale).toBe(true);
    expect(result.stale_reason).toBe('rate_limited');
    expect(fetch).toHaveBeenCalledTimes(1); // no retry
  });

  it('HTTP 500 — retries 2x then returns stale', async () => {
    vi.useFakeTimers();
    fetch.mockResolvedValue({ ok: false, status: 500 });

    const promise = callClaude(mockData, '墾丁', 'desc');
    // Advance past the two 5s sleeps
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.stale).toBe(true);
    expect(result.stale_reason).toBe('http_500');
    expect(fetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    vi.useRealTimers();
  });

  it('HTTP 400 — stale immediately, no retry', async () => {
    fetch.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
    const result = await callClaude(mockData, '墾丁', 'desc');
    expect(result.stale).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('JSON parse error — returns stale', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: 'not json at all' }] }),
    });
    const result = await callClaude(mockData, '墾丁', 'desc');
    expect(result.stale).toBe(true);
    expect(result.stale_reason).toBe('json_parse_error');
  });

  it('summary > 20 chars — truncated to 20 code points', async () => {
    const longSummary = '這是一個超過二十個字的衝浪建議內容應該被截斷掉';
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ text: `{"rating":3,"summary":"${longSummary}","notes":null}` }],
      }),
    });
    const result = await callClaude(mockData, '墾丁', 'desc');
    expect([...result.summary].length).toBeLessThanOrEqual(20);
  });

  it('rating out of range — clamped to [1,5]', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ text: '{"rating":7,"summary":"好浪","notes":null}' }],
      }),
    });
    const result = await callClaude(mockData, '墾丁', 'desc');
    expect(result.rating).toBe(5);
  });
});
