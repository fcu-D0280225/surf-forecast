/* Service Worker — 台灣衝浪預報 PWA */
const CACHE_STATIC   = 'surf-static-v2';
const CACHE_FORECAST = 'surf-forecast-v1';
const MAX_AGE_FORECAST = 24 * 60 * 60; // 24h in seconds

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/spots.json',
  '/icons/icon.svg',
];

/* ── Install: pre-cache static assets ─────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

/* ── Activate: clean up old caches ────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC && k !== CACHE_FORECAST)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ── Fetch Strategy ────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // /data/*.json — stale-while-revalidate, 24h max-age
  if (url.pathname.startsWith('/data/') && url.pathname.endsWith('.json')) {
    event.respondWith(staleWhileRevalidate(event.request, CACHE_FORECAST, MAX_AGE_FORECAST));
    return;
  }

  // /spots.json — stale-while-revalidate (7d)
  if (url.pathname === '/spots.json') {
    event.respondWith(staleWhileRevalidate(event.request, CACHE_STATIC, 7 * 24 * 60 * 60));
    return;
  }

  // Static assets — cache-first
  if (event.request.method === 'GET') {
    event.respondWith(cacheFirst(event.request, CACHE_STATIC));
  }
});

/* ── Cache strategies ──────────────────────────────────────────── */

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
