const CACHE_NAME = 'pico-pwa-v1';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './browser-api.js',
  './renderer.js',
  './manifest.webmanifest',
  './assets/icons/macos/128x128.png',
  './assets/icons/macos/256x256.png',
  './assets/icons/macos/512x512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => (key === CACHE_NAME ? null : caches.delete(key)))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const shouldCache = response.ok && new URL(event.request.url).origin === self.location.origin;
        if (shouldCache) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
