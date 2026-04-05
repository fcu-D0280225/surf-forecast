/**
 * app.js — 台灣衝浪預報 PWA
 * 從 /data/{slug}.json 讀取預先生成的預報，渲染浪點卡片。
 * 用戶可自選顯示哪些浪點（存 localStorage）。
 */

// ── Service Worker Registration ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── Constants ─────────────────────────────────────────────────────────────────
const LS_SELECTED = 'surf-selected-spots';
const LS_FEEDBACK = 'surf-feedback';

// ── State ─────────────────────────────────────────────────────────────────────
let allSpots    = [];   // from /spots.json
let forecasts   = {};   // slug → forecast JSON
let selected    = [];   // slugs user wants to see
let currentUser = null; // { username, displayName, isAdmin, points }

// ── Auth ──────────────────────────────────────────────────────────────────────
async function checkAuth() {
  const res = await fetch('/api/auth/me');
  if (res.status === 401) {
    window.location.href = '/login.html';
    return false;
  }
  currentUser = await res.json();
  updatePointsBadge();
  document.getElementById('logout-btn').hidden = false;
  return true;
}

function updatePointsBadge() {
  const badge = document.getElementById('points-badge');
  if (!currentUser) { badge.hidden = true; return; }
  if (currentUser.isAdmin) {
    badge.textContent = '👑 管理員';
    badge.hidden = false;
  } else {
    badge.textContent = `💧 ${currentUser.points ?? 0} 點`;
    badge.hidden = false;
  }
}

window.doLogout = async function () {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
};

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  if (!await checkAuth()) return;

  try {
    const res = await fetch('/spots.json');
    if (!res.ok) throw new Error(`spots.json ${res.status}`);
    allSpots = await res.json();
  } catch (err) {
    showError('無法載入浪點設定：' + err.message);
    return;
  }

  // Load user selection (default: all)
  const saved = localStorage.getItem(LS_SELECTED);
  selected = saved
    ? JSON.parse(saved).filter(s => allSpots.some(sp => sp.slug === s))
    : allSpots.map(sp => sp.slug);

  buildSpotSelector();
  await loadForecasts();
  renderCards();
  renderAccuracy();
  await loadWeeklyReport();
}

// ── Spot Selector ─────────────────────────────────────────────────────────────
function buildSpotSelector() {
  const container = document.getElementById('spot-checkboxes');
  container.innerHTML = '';

  // Group by region
  const regions = [...new Set(allSpots.map(s => s.region))];
  regions.forEach(region => {
    const group = document.createElement('div');
    group.className = 'region-group';
    group.innerHTML = `<div class="region-label">${region}</div>`;

    allSpots.filter(s => s.region === region).forEach(spot => {
      const label = document.createElement('label');
      label.className = 'spot-check-label';
      const checked = selected.includes(spot.slug) ? 'checked' : '';
      label.innerHTML = `
        <input type="checkbox" value="${spot.slug}" ${checked} onchange="onSpotToggle(this)">
        <span class="spot-check-name">${spot.name}</span>
        <span class="spot-check-desc">${spot.description}</span>
      `;
      group.appendChild(label);
    });

    container.appendChild(group);
  });
}

window.toggleSpotSelector = function () {
  const panel = document.getElementById('spot-selector');
  const btn   = document.getElementById('spot-toggle-btn');
  const isHidden = panel.hidden;
  panel.hidden = !isHidden;
  btn.classList.toggle('active', isHidden);
};

window.onSpotToggle = function (checkbox) {
  const slug = checkbox.value;
  if (checkbox.checked) {
    if (!selected.includes(slug)) selected.push(slug);
  } else {
    selected = selected.filter(s => s !== slug);
  }
  localStorage.setItem(LS_SELECTED, JSON.stringify(selected));
  renderCards();
};

window.selectAll = function () {
  selected = allSpots.map(s => s.slug);
  localStorage.setItem(LS_SELECTED, JSON.stringify(selected));
  buildSpotSelector();
  renderCards();
};

window.selectNone = function () {
  selected = [];
  localStorage.setItem(LS_SELECTED, JSON.stringify(selected));
  buildSpotSelector();
  renderCards();
};

// ── Load Forecasts ────────────────────────────────────────────────────────────
async function loadForecasts() {
  const results = await Promise.allSettled(
    allSpots.map(spot =>
      fetch(`/data/${spot.slug}.json`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
        .then(data => ({ slug: spot.slug, data }))
    )
  );

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      forecasts[r.value.slug] = r.value.data;
    } else {
      forecasts[allSpots[i].slug] = null; // no data yet
    }
  });

  // Update header date
  const dates = Object.values(forecasts).filter(Boolean).map(f => f.date);
  if (dates.length) {
    const d = dates[0];
    document.getElementById('forecast-date').textContent =
      `明天 ${d} 的預報`;
  } else {
    document.getElementById('forecast-date').textContent = '尚無預報資料';
  }
}

// ── Render Cards ──────────────────────────────────────────────────────────────
function renderCards() {
  const container = document.getElementById('cards');
  const loading   = document.getElementById('loading');
  if (loading) loading.remove();

  if (selected.length === 0) {
    container.innerHTML = '<p class="empty-state">請選擇至少一個浪點 ⚙️</p>';
    return;
  }

  const visibleSpots = allSpots.filter(s => selected.includes(s.slug));

  container.innerHTML = '';
  visibleSpots.forEach(spot => {
    const f = forecasts[spot.slug];
    container.appendChild(buildCard(spot, f));
  });
}

function buildCard(spot, f) {
  const article = document.createElement('article');
  article.className = 'spot-card';
  article.dataset.slug = spot.slug;

  if (!f) {
    article.innerHTML = `
      <div class="card-header" onclick="toggleCard(this)">
        <div class="card-header-left">
          <h2>${spot.name}</h2>
          <span class="region-tag">${spot.region}</span>
        </div>
        <span class="card-chevron">▼</span>
      </div>
      <div class="card-body">
        <p class="no-data">尚無預報資料</p>
      </div>
    `;
    article.querySelector('.card-body').hidden = true;
    return article;
  }

  const confLabel  = { high: '高信心', med: '中信心', low: '低信心' }[f.confidence] ?? '';
  const confClass  = { high: 'conf-high', med: 'conf-med', low: 'conf-low' }[f.confidence] ?? '';
  const stars      = f.rating ? renderStars(f.rating) : '—';
  const windDir    = f.wind_direction_deg != null ? degToArrow(f.wind_direction_deg) : '';
  const swellDir   = f.swell_direction_deg != null ? degToArrow(f.swell_direction_deg) : '';
  const staleBanner = f.stale
    ? `<div class="stale-banner">⚠️ ${f.stale_since ? `資料自 ${f.stale_since.slice(0, 10)} 起未更新` : '資料略舊'}</div>`
    : '';

  const subSpotsHtml = spot.sub_spots?.length
    ? `<span class="sub-spots-tag">${spot.sub_spots.join(' · ')}</span>`
    : '';

  article.innerHTML = `
    ${staleBanner}
    <div class="card-header" onclick="toggleCard(this)">
      <div class="card-header-left">
        <h2>${spot.name}</h2>
        <span class="region-tag">${spot.region}</span>
        ${subSpotsHtml}
      </div>
      <div class="card-header-right">
        <span class="stars">${stars}</span>
        <span class="card-chevron">▼</span>
      </div>
    </div>
    <div class="card-body" hidden>
      <p class="summary">${f.summary ?? ''}</p>
      <div class="metrics">
        <div class="metric">
          <span class="metric-label">湧浪</span>
          <span class="metric-value">${f.swell_height_m ?? '—'}m ${swellDir}</span>
          <span class="metric-sub">${f.swell_period_s ?? '—'}s</span>
        </div>
        <div class="metric">
          <span class="metric-label">風浪</span>
          <span class="metric-value">${f.wind_wave_height_m ?? '—'}m</span>
          <span class="metric-sub">${f.wind_speed_ms ?? '—'} m/s ${windDir}</span>
        </div>
        <div class="metric">
          <span class="metric-label">最佳時窗</span>
          <span class="metric-value">${f.best_window_start}–${f.best_window_end}</span>
        </div>
      </div>
      ${f.notes ? `<p class="notes">📌 ${f.notes}</p>` : ''}
      <div class="card-footer">
        <span class="conf-badge ${confClass}">${confLabel}</span>
        ${f.wind_model_spread_ms != null ? `<span class="spread-badge spread-${f.wind_model_spread_ms > 4 ? 'high' : f.wind_model_spread_ms > 2 ? 'med' : 'low'}">模型差異 ${f.wind_model_spread_ms} m/s</span>` : ''}
      </div>
    </div>
  `;

  return article;
}

window.toggleCard = function (header) {
  const body    = header.nextElementSibling;
  const chevron = header.querySelector('.card-chevron');
  const open    = body.hidden;
  body.hidden   = !open;
  chevron.textContent = open ? '▲' : '▼';
};

// ── Report (自由文字回饋) ──────────────────────────────────────────────────────
window.submitReport = async function () {
  const textarea = document.getElementById('report-input');
  const done     = document.getElementById('report-done');
  const content  = textarea.value.trim();
  if (!content) return;

  try {
    await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.warn('[report]', err.message);
  }

  textarea.value = '';
  done.hidden = false;
  setTimeout(() => { done.hidden = true; }, 3000);
};

// ── 好浪命中率 ────────────────────────────────────────────────────────────────
function getFeedback() {
  try {
    return JSON.parse(localStorage.getItem(LS_FEEDBACK) ?? '[]');
  } catch {
    return [];
  }
}

function renderAccuracy() {
  const bar  = document.getElementById('accuracy-bar');
  const records = getFeedback().filter(r => r.ai_rating != null && r.went !== null);
  const denom = records.length;

  if (denom < 5) { bar.hidden = true; return; }

  const numer = records.filter(r => r.went === true && r.ai_rating >= 3).length;
  const pct   = Math.round(numer / denom * 100);

  bar.hidden = false;
  bar.innerHTML = `
    <span class="accuracy-label">好浪命中率</span>
    <span class="accuracy-value">${pct}%</span>
    <span class="accuracy-meta">（${denom} 筆回饋）</span>
  `;
}

// ── Weekly Report ─────────────────────────────────────────────────────────────
async function loadWeeklyReport() {
  let report;
  try {
    const res = await fetch('/data/weekly-report.json');
    if (!res.ok) return; // no weekly data yet
    report = await res.json();
  } catch {
    return;
  }

  const section = document.getElementById('weekly-section');
  const meta    = document.getElementById('weekly-meta');
  const cards   = document.getElementById('weekly-cards');

  section.hidden = false;

  const genDate = report.generated_at?.slice(0, 10) ?? '';
  meta.innerHTML = `
    <span class="weekly-range">📅 ${report.week_start} ~ ${report.week_end}</span>
    ${report.seasonal_context ? `<span class="weekly-season">${report.seasonal_context}</span>` : ''}
    <span class="weekly-gen">（更新：${genDate}）</span>
  `;

  cards.innerHTML = '';
  (report.regions ?? []).forEach(r => {
    cards.appendChild(buildWeeklyRegionCard(r));
  });
}

function buildWeeklyRegionCard(r) {
  const div = document.createElement('div');
  div.className = 'weekly-region-card';

  if (r.error) {
    div.innerHTML = `
      <div class="weekly-region-header">
        <span class="weekly-region-name">${r.region}</span>
        <span class="weekly-spots">${(r.spots ?? []).join(' · ')}</span>
      </div>
      <p class="weekly-error">資料暫無法取得</p>
    `;
    return div;
  }

  const dailyHtml = (r.daily_ratings ?? []).map(d => {
    const stars = d.rating ? renderStars(d.rating) : '—';
    return `
      <div class="weekly-day">
        <span class="weekly-day-label">${d.weekday}</span>
        <span class="weekly-day-stars">${stars}</span>
        <span class="weekly-day-note">${d.note ?? ''}</span>
      </div>
    `;
  }).join('');

  div.innerHTML = `
    <div class="weekly-region-header">
      <span class="weekly-region-name">${r.region}</span>
      <span class="weekly-spots">${(r.spots ?? []).join(' · ')}</span>
    </div>
    <p class="weekly-summary">${r.overall_summary ?? ''}</p>
    <div class="weekly-best-worst">
      <span class="weekly-best">👍 最佳：${r.best_day ?? '—'}</span>
      <span class="weekly-worst">👎 最差：${r.worst_day ?? '—'}</span>
    </div>
    ${r.highlight ? `<p class="weekly-highlight">⚠️ ${r.highlight}</p>` : ''}
    <div class="weekly-days">${dailyHtml}</div>
  `;
  return div;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function renderStars(rating) {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

function degToArrow(deg) {
  const arrows = ['↑','↗','→','↘','↓','↙','←','↖'];
  return arrows[Math.round((deg % 360) / 45) % 8];
}

function showError(msg) {
  document.getElementById('cards').innerHTML = `<p class="error-state">⚠️ ${msg}</p>`;
}

// ── Chat Widget ───────────────────────────────────────────────────────────────

window.chatKeydown = function (e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendChat();
  }
};

window.quickAsk = function (question) {
  const input = document.getElementById('chat-input');
  input.value = question;
  sendChat();
};

window.toggleWeekly = function () {
  const body    = document.getElementById('weekly-body');
  const chevron = document.getElementById('weekly-chevron');
  const open    = body.hidden;
  body.hidden   = !open;
  chevron.textContent = open ? '▲' : '▼';
};

window.toggleBrowse = function () {
  const body    = document.getElementById('browse-body');
  const chevron = document.getElementById('browse-chevron');
  const open    = body.hidden;
  body.hidden   = !open;
  chevron.textContent = open ? '▲' : '▼';
};

window.sendChat = async function () {
  const input   = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const question = input.value.trim();
  if (!question) return;

  // Hide quick prompts after first use
  const prompts = document.getElementById('quick-prompts');
  if (prompts) prompts.hidden = true;

  input.value = '';
  input.disabled = true;
  sendBtn.textContent = '取消';
  sendBtn.disabled = false;

  appendChatMsg('user', question);
  const loading = appendChatMsg('assistant', '🌊 AI 思考中…');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  sendBtn.onclick = () => {
    controller.abort();
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    if (res.status === 402) {
      loading.textContent = '點數不足，請聯絡管理員補充點數。';
      return;
    }
    const data = await res.json();
    loading.textContent = data.answer ?? data.error ?? '無法取得回答';
    // 更新剩餘點數
    if (typeof data.remainingPoints === 'number' && currentUser) {
      currentUser.points = data.remainingPoints;
      updatePointsBadge();
    }

    // Render inline spot cards if server returned matched spots
    if (data.spots?.length) {
      const row = document.createElement('div');
      row.className = 'inline-cards-row';
      data.spots.forEach(spot => row.appendChild(buildInlineCard(spot)));
      loading.after(row);
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      loading.textContent = '已取消。';
    } else {
      loading.textContent = '網路錯誤，請稍後再試';
    }
  } finally {
    input.disabled = false;
    sendBtn.textContent = '送出';
    sendBtn.onclick = sendChat;
    input.focus();
  }
};

function buildInlineCard(spot) {
  const stars = spot.rating ? renderStars(spot.rating) : '—';
  const div = document.createElement('div');
  div.className = 'inline-spot-card';
  div.innerHTML = `
    <div class="isc-header">
      <span class="isc-name">${spot.name}</span>
      <span class="region-tag">${spot.region}</span>
    </div>
    <div class="isc-body">
      <span class="stars">${stars}</span>
      <span class="isc-window">⏰ ${spot.best_window_start}–${spot.best_window_end}</span>
    </div>
    <p class="isc-summary">${spot.summary ?? ''}</p>
  `;
  return div;
}

function appendChatMsg(role, text) {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = `chat-msg chat-${role}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
