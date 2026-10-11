// CloudSSH service worker: network-first with offline fallback for the app shell.
// Never intercepts API, MCP, SFTP or settings routes. Hashed /assets/* files are
// immutable and therefore cache-first, which keeps offline start-up working with
// the split standalone shell.
const CACHE = 'cloudssh-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.add(new Request('/', { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp') || url.pathname.startsWith('/account/') || url.pathname.startsWith('/automation')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Immutable hashed asset: cache-first, fill the cache on the first fetch.
    const immutableAsset = url.pathname.startsWith('/assets/');
    if (immutableAsset) {
      const cachedAsset = await cache.match(request);
      if (cachedAsset) return cachedAsset;
    }
    try {
      const response = await fetch(request);
      // Cache the app shell for offline start-up.
      if (response.ok && (request.mode === 'navigate' || url.pathname === '/' || immutableAsset)) {
        cache.put(immutableAsset ? request : new Request('/', { cache: 'reload' }), response.clone());
      }
      return response;
    } catch {
      const cached = (await cache.match(request)) || (await cache.match('/'));
      if (cached) return cached;
      return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});

// ---------- Web Push notifications (CloudSSH uptime / cron alerts) ----------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  event.waitUntil(self.registration.showNotification(data.title || 'CloudSSH', {
    body: data.body || '',
    tag: data.tag || 'cloudssh',
    icon: '/favicon.ico',
    renotify: true,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow('/');
  })());
});
