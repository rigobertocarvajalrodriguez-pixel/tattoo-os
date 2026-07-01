const CACHE = 'tattoo-os-v7';
const OFFLINE_URL = './index.html';

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll([OFFLINE_URL]);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('supabase') || e.request.url.includes('/api/')) return;

  // HTML: network-first so updates are always picked up
  var isHTML = e.request.headers.get('accept') && e.request.headers.get('accept').includes('text/html');
  if (isHTML) {
    e.respondWith(
      fetch(e.request).then(function(response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        }
        return response;
      }).catch(function() {
        return caches.match(e.request) || caches.match(OFFLINE_URL);
      })
    );
    return;
  }

  // Assets: cache-first
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      var networkFetch = fetch(e.request).then(function(response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        }
        return response;
      }).catch(function() {
        return cached || caches.match(OFFLINE_URL);
      });
      return cached || networkFetch;
    })
  );
});
