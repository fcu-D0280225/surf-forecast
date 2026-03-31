/* Service Worker — 台灣衝浪助手 PWA */
const CACHE_NAME = 'surf-v1';
const STATIC_ASSETS = [
  '/style.css',
  '/login.css',
  '/manifest.json',
  '/icons/icon.svg',
];

/* ── Install: pre-cache static assets ─────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

/* ── Activate: clean up old caches ────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* ── Fetch strategy ────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls: network only (never cache)
  if (url.pathname.startsWith('/api/')) return;

  // Static assets: cache first, then network; update cache in background
  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(event.request);
      const fetchPromise = fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET') {
          cache.put(event.request, response.clone());
        }
        return response;
      }).catch(() => null);

      // Return cached immediately if available, otherwise wait for network
      return cached || fetchPromise;
    })
  );
});
