/* Taiwan Street Vision Project — service worker (PWA installability + light offline) */
const VERSION = 'vzt-atlas-v4';   // bump to invalidate installed-app caches after each release
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-180.png'
];

// Never runtime-cache the very large per-county datasets (tens of MB each)
const NO_CACHE = [/\/data\/poles\//, /\/data\/sidewalks26\//];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.allSettled(CORE.map((u) => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Page navigations: network-first, fall back to cache, then offline home
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put(req, net.clone());
        return net;
      } catch (err) {
        const cached = await caches.match(req);
        return cached || (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Same-origin assets: stale-while-revalidate (skipping the huge datasets)
  if (url.origin === self.location.origin && !NO_CACHE.some((re) => re.test(url.pathname))) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok && res.status === 200) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
    return;
  }

  // Cross-origin (map tiles, unpkg, fonts): cache-first runtime
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res) cache.put(req, res.clone());
      return res;
    } catch (err) {
      return cached || Response.error();
    }
  })());
});
