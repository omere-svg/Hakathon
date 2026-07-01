// Maestro Open service worker — app-shell offline cache.
// Strategy: network-FIRST for navigations (so updates are never stuck stale), and
// cache-FIRST for same-origin static assets. Model weights are NOT cached here —
// WebLLM caches those itself (Cache API / IndexedDB / OPFS). This only makes the app
// shell + lesson JSON available offline after the first visit. Registered in production
// only (see main.tsx) so dev is never affected.
const CACHE = 'maestro-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add('/')).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // network-first; fall back to cached shell offline
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('/', copy));
        return res;
      }).catch(() => caches.match('/').then((r) => r || Response.error())),
    );
    return;
  }

  // static assets: cache-first, then network (and cache it)
  event.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => hit),
    ),
  );
});
