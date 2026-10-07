/**
 * Service worker – makes the app installable and usable offline.
 *
 * Strategy
 *  - App files (same origin): network-first, cache fallback. You always get the
 *    latest deploy when online; the last copy works offline. No stale-deploy bugs.
 *  - /api/cse + /api/news GET: network-first, cache fallback (last prices/news offline).
 *  - /api/auth + /api/data: NEVER cached (private, per-user) – always network.
 *  - Pinned CDN libraries + Google Fonts: cache-first (URLs are versioned).
 *
 * Bump VERSION when the precache list changes.
 */
const VERSION = 'v3.1.0';
const CACHE = `cse-portfolio-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/css/styles.css',
  'assets/icons/icon.svg',
  'assets/icons/icon-192.png',
  'assets/js/theme-init.js',
  'assets/js/main.js',
  'assets/js/core/account.js',
  'assets/js/core/api.js',
  'assets/js/core/finance.js',
  'assets/js/core/loader.js',
  'assets/js/core/prices.js',
  'assets/js/core/router.js',
  'assets/js/core/store.js',
  'assets/js/core/symbols.js',
  'assets/js/core/sync.js',
  'assets/js/core/ui.js',
  'assets/js/core/utils.js',
  'assets/js/data/reference.js',
  'assets/js/views/auth.js',
  'assets/js/views/calculator.js',
  'assets/js/views/charts.js',
  'assets/js/views/dividends.js',
  'assets/js/views/fundamentals.js',
  'assets/js/views/history.js',
  'assets/js/views/market.js',
  'assets/js/views/news.js',
  'assets/js/views/portfolio.js',
  'assets/js/views/settings.js',
  'assets/js/views/technical.js',
];

const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.sheetjs.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Add one by one so a single missing file never breaks installation.
    await Promise.all(SHELL.map((p) => cache.add(new URL(p, self.registration.scope)).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('cse-portfolio-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (hit) return hit;
    if (fallbackUrl) {
      const shell = await cache.match(new URL(fallbackUrl, self.registration.scope));
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // Account + portfolio data are private: let the browser hit the network directly.
    if (url.pathname.endsWith('/api/auth') || url.pathname.endsWith('/api/data')) return;
    if (request.mode === 'navigate') event.respondWith(networkFirst(request, 'index.html'));
    else event.respondWith(networkFirst(request));
    return;
  }
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
  // Everything else (TradingView, news links) goes straight to the network.
});
