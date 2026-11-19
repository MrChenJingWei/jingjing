const CACHE = 'jingjing-shell-v48';
const ASSET_VERSION = '20261119-4';
const ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  `/style.css?v=${ASSET_VERSION}`,
  `/app.js?v=${ASSET_VERSION}`,
  '/js/core.js',
  '/js/ui.js',
  '/js/shell.js',
  '/js/chat.js',
  '/js/tasks.js',
  '/js/memory.js',
  '/js/settings.js',
  '/js/workers.js',
  '/js/plugins.js',
  '/js/automation.js',
  '/js/system.js',
  '/js/sync.js',
  '/js/classify.js',
  '/js/select.js',
  '/js/folder.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/logo-wordmark.svg',
  '/logo-wordmark-dark.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 导航请求：优先网络，断网时回缓存外壳，再退回离线页
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(async () => {
          return (await caches.match(request)) || (await caches.match('/')) || (await caches.match('/offline.html'));
        })
    );
    return;
  }

  // 静态资源：网络优先，断网时回缓存，避免升级后仍拿到旧脚本
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/offline.html')))
  );
});
