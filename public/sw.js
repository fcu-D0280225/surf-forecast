/* Service Worker — 台灣衝浪預報 PWA */
const CACHE_SHELL    = 'surf-shell-v3';
const CACHE_FORECAST = 'surf-forecast-v1';
const MAX_AGE_FORECAST = 24 * 60 * 60; // 24h in seconds

/* ── Install: minimal pre-cache (only offline fallback) ────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_SHELL).then(cache => cache.addAll(['/offline.html']))
      .catch(() => {}) // offline.html optional
  );
  self.skipWaiting();
});

/* ── Activate: clean up ALL old caches ────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_SHELL && k !== CACHE_FORECAST)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ── Fetch Strategy ────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API 請求 — 不快取，直接走網路
  if (url.pathname.startsWith('/api/')) return;

  // /data/*.json — stale-while-revalidate, 24h max-age
  if (url.pathname.startsWith('/data/') && url.pathname.endsWith('.json')) {
    event.respondWith(staleWhileRevalidate(event.request, CACHE_FORECAST, MAX_AGE_FORECAST));
    return;
  }

  // HTML / JS / CSS / 頁面資源 — network-first（永遠抓最新，離線才用快取）
  if (event.request.method === 'GET') {
    event.respondWith(networkFirst(event.request, CACHE_SHELL));
  }
});

/* ── Cache strategies ──────────────────────────────────────────── */

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached ?? new Response('離線中，請稍後再試', { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName, maxAgeSeconds) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  if (cached) {
    const dateHeader = cached.headers.get('date');
    if (dateHeader) {
      const age = (Date.now() - new Date(dateHeader).getTime()) / 1000;
      if (age > maxAgeSeconds) return fetchPromise || cached;
    }
    fetchPromise; // background refresh
    return cached;
  }

  return fetchPromise;
}

async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request).catch(() => null);
  if (response?.ok) cache.put(request, response.clone());
  return response;
}
