// Tilapiya CRM Service Worker
const CACHE_NAME = 'tilapiya-crm-v1';
const SHELL_FILES = ['./', './index.html', './manifest.json'];

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
  // Skip caching for: Supabase, API routes, Groq, OpenAI, Facebook/Meta
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.in')) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.hostname.includes('groq.com') || url.hostname.includes('openai.com') || url.hostname.includes('facebook.com') || url.hostname.includes('graph.facebook.com')) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (e.request.method === 'GET' && response.status === 200 && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      });
    }).catch(() => {
      if (e.request.mode === 'navigate') return caches.match('./index.html');
    })
  );
});
