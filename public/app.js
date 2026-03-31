/* ── DOM refs ─────────────────────────────────────────────────── */
const messagesEl = document.getElementById('messages');
const inputEl    = document.getElementById('input');
const sendBtn    = document.getElementById('send-btn');

/* ── Quick action buttons ─────────────────────────────────────── */
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    inputEl.value = btn.dataset.msg;
    sendMessage();
  });
});

/* ── Auto-resize textarea ─────────────────────────────────────── */
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = inputEl.scrollHeight + 'px';
});

/* ── Enter to send (Shift+Enter = newline) ────────────────────── */
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

/* ── Send message ─────────────────────────────────────────────── */
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || sendBtn.disabled) return;

  appendMessage('user', text);
  inputEl.value = '';
  inputEl.style.height = 'auto';
  sendBtn.disabled = true;

  // Typing indicator
  const typingId = appendTyping();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });

    removeMessage(typingId);

    if (!response.ok) {
      appendMessage('assistant', '⚠️ 伺服器錯誤，請稍後再試');
      return;
    }

    // SSE stream reading
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';
    let   bubbleId  = null;
    let   finalText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (raw === '[DONE]') break;

        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }

        if (evt.type === 'status') {
          appendStatus(evt.text);
        } else if (evt.type === 'text') {
          // Streaming partial text — append to live bubble
          if (!bubbleId) bubbleId = appendMessage('assistant', '', true);
          appendToMessage(bubbleId, evt.text);
          finalText += evt.text;
        } else if (evt.type === 'done') {
          // Final complete result (replace live bubble or create new)
          if (bubbleId) {
            setMessageText(bubbleId, evt.text);
          } else {
            appendMessage('assistant', evt.text);
          }
          finalText = evt.text;
          loadLogs(); // refresh log table after any response
        } else if (evt.type === 'error') {
          appendMessage('assistant', `⚠️ ${evt.text}`);
        }
      }
    }

    // Fallback: if only 'text' events came (no 'done'), keep as-is
    if (!finalText && bubbleId) {
      // do nothing
    }

  } catch (err) {
    removeMessage(typingId);
    appendMessage('assistant', `⚠️ 連線錯誤：${err.message}`);
  }

  sendBtn.disabled = false;
  inputEl.focus();
}

/* ── Message helpers ──────────────────────────────────────────── */
let msgCounter = 0;

function appendMessage(role, text, empty = false) {
  const id  = 'msg-' + (++msgCounter);
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.id = id;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (!empty) bubble.textContent = text;
  div.appendChild(bubble);

  messagesEl.appendChild(div);
  scrollBottom();
  return id;
}

function appendToMessage(id, text) {
  const el = document.getElementById(id)?.querySelector('.bubble');
  if (el) {
    el.textContent += text;
    scrollBottom();
  }
}

function setMessageText(id, text) {
  const el = document.getElementById(id)?.querySelector('.bubble');
  if (el) {
    el.textContent = text;
    scrollBottom();
  }
}

function appendStatus(text) {
  const id  = 'msg-' + (++msgCounter);
  const div = document.createElement('div');
  div.className = 'message status';
  div.id = id;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  div.appendChild(bubble);
  messagesEl.appendChild(div);
  // Auto-remove status after 8s
  setTimeout(() => div.remove(), 8000);
  scrollBottom();
  return id;
}

function appendTyping() {
  const id  = 'msg-' + (++msgCounter);
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = id;
  div.innerHTML = `<div class="bubble">
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
  </div>`;
  messagesEl.appendChild(div);
  scrollBottom();
  return id;
}

function removeMessage(id) {
  document.getElementById(id)?.remove();
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ── Load logs table ──────────────────────────────────────────── */
async function loadLogs() {
  const wrap = document.getElementById('logs-table-wrap');
  try {
    const res  = await fetch('/api/logs');
    const rows = await res.json();

    if (!rows.length) {
      wrap.innerHTML = '<p class="logs-empty">還沒有任何衝浪紀錄</p>';
      return;
    }

    const ratingClass = r => `rating-${r}`;

    const condTags = (row) => {
      const tags = [];
      if (row.wave_height_m    != null) tags.push(`浪${row.wave_height_m}m`);
      if (row.swell_height_m   != null) tags.push(`湧${row.swell_height_m}m`);
      if (row.wave_period_s    != null) tags.push(`${row.wave_period_s}s`);
      if (row.wave_direction_text)      tags.push(`浪向${row.wave_direction_text}`);
      if (row.wind_speed_kmh   != null) tags.push(`風${row.wind_speed_kmh}km/h`);
      if (row.wind_direction_text)      tags.push(row.wind_direction_text);
      if (row.water_temp_c     != null) tags.push(`水溫${row.water_temp_c}°C`);
      if (row.weather_text)             tags.push(row.weather_text);
      if (row.tide)                     tags.push(row.tide);
      return tags.map(t => `<span class="cond-tag">${t}</span>`).join('');
    };

    wrap.innerHTML = `
      <div style="overflow-x:auto">
        <table class="log-table">
          <thead>
            <tr>
              <th>日期</th>
              <th>地點</th>
              <th>評價</th>
              <th>海況</th>
              <th>備註</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${r.date_iso}</td>
                <td>${r.spot}</td>
                <td class="${ratingClass(r.rating)}">${r.rating}</td>
                <td>${condTags(r) || '<span style="color:#9ca3af">—</span>'}</td>
                <td>${r.notes || ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`;
  } catch {
    wrap.innerHTML = '<p class="logs-empty">無法載入紀錄</p>';
  }
}

// ── Auth ──────────────────────────────────────────────────────────
async function initAuth() {
  try {
    const res  = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login'; return; }
    const data = await res.json();
    document.getElementById('display-name').textContent = `👤 ${data.displayName}`;
  } catch {
    window.location.href = '/login';
  }
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// 攔截 401，自動跳登入頁
const _origFetch = window.fetch;
window.fetch = async (...args) => {
  const res = await _origFetch(...args);
  if (res.status === 401) { window.location.href = '/login'; }
  return res;
};

/* ── Log form submit ──────────────────────────────────────────── */
async function submitLog(e) {
  e.preventDefault();
  const form    = e.target;
  const btn     = document.getElementById('log-submit-btn');
  const msgEl   = document.getElementById('log-form-msg');
  const data    = Object.fromEntries(new FormData(form));

  btn.disabled  = true;
  msgEl.textContent = '儲存中…';
  msgEl.className   = '';

  try {
    const res = await fetch('/api/logs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '儲存失敗');
    msgEl.textContent = `✅ 已儲存（${json.spot}）`;
    msgEl.className   = 'form-msg-ok';
    form.reset();
    loadLogs();
  } catch (err) {
    msgEl.textContent = `❌ ${err.message}`;
    msgEl.className   = 'form-msg-err';
  } finally {
    btn.disabled = false;
  }
}

// Load on startup
initAuth();
loadLogs();
// Default log date to today
const todayIso = new Date().toLocaleDateString('sv'); // YYYY-MM-DD
const logDateEl = document.getElementById('log-date');
if (logDateEl) { logDateEl.value = todayIso; logDateEl.max = todayIso; }
