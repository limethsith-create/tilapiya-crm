// Tilapiya CRM Service Worker
// Version-stamped cache: bump the date suffix on each deploy to invalidate old caches.
const CACHE_NAME = 'tilapiya-crm-v2-20260612';
const SHELL_FILES = [
  './', './index.html', './manifest.json',
  'https://cdn.jsdelivr.net/npm/chart.js@4'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // NEVER cache or intercept API routes, Supabase, or AI/Meta endpoints
  if (url.pathname.startsWith('/api/')) return;
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.in')) return;
  if (url.hostname.includes('groq.com') || url.hostname.includes('openai.com') || url.hostname.includes('facebook.com') || url.hostname.includes('graph.facebook.com')) return;

  // Network-first for navigations / index.html so users always get the latest app shell
  const isNavigation = e.request.mode === 'navigate' ||
    (url.origin === self.location.origin && (url.pathname.endsWith('/index.html') || url.pathname.endsWith('/')));
  if (isNavigation) {
    e.respondWith(
      fetch(e.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() =>
        caches.match(e.request).then(cached => cached || caches.match('./index.html'))
      )
    );
    return;
  }

  // Cache-first for CDN libraries and other same-origin static assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response.status === 200 && (url.origin === self.location.origin || url.hostname === 'cdn.jsdelivr.net')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      });
    }).catch(() => {
      // Offline fallback to the cached app shell — only for navigation requests
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    })
  );
});
