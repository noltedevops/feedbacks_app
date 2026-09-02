// Bumped from v1: that cache exists on installed devices but is empty, because the
// install below never completed. Renaming lets the activate handler drop it.
const CACHE_NAME = 'uxo-tracker-v3';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  // index.html has always shipped an SVG favicon; there has never been a
  // favicon.ico in this repo. The .ico path was inherited boilerplate.
  '/favicon.svg',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap'
];

// Install Service Worker and cache core static shell.
//
// cache.addAll() is atomic: a single failed request rejects the whole call, which
// rejects the waitUntil promise, which fails the install event, so the worker never
// activates and NOTHING is cached. The stale '/favicon.ico' entry above hit that
// path - one 404 was silently costing the app its entire offline mode, while
// register() still resolved and logged success in the page.
//
// Caching each asset individually keeps one unreachable URL from costing more than
// that asset. That matters beyond the favicon: the font stylesheet is cross-origin,
// so a crew installing the app somewhere with no signal would otherwise end up with
// no offline shell at all - the exact situation this app exists for.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const results = await Promise.allSettled(
        ASSETS_TO_CACHE.map((asset) => cache.add(asset))
      );
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          console.warn('Precache skipped:', ASSETS_TO_CACHE[i], result.reason);
        }
      });
    })
  );
  self.skipWaiting();
});

// Clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Removing old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch interception
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Extensions in the user's browser issue requests through the page, and the
  // Cache API only accepts http(s) - cache.put on a chrome-extension:// request
  // throws. The rejection was detached from the response, so it never broke the
  // page, it just filled the console and buried real errors.
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // Bypass caching for backend REST API endpoints
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // The document itself is network-first.
  //
  // Vite names every asset by content hash, so a new build is only reachable
  // through the new index.html that references it. Serving that document from
  // cache first - which is what the generic handler below does - pinned the app
  // to whichever build the cache last held: the revalidation updated the cache
  // for next time, so a reload always ran the previous build, and a stale enough
  // one still referenced bundles from before the basemap was raster at all. That
  // is the black map, and why clearing the cache by hand appeared to fix things.
  //
  // Cache still answers when the network does not, so offline is unaffected.
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // Network-first falling back to cache for static resources (CSS/JS files are hash-named in Vite)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch in background to update cache (stale-while-revalidate)
        fetch(event.request).then((networkResponse) => {
          if (networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => {/* Ignore network failures when offline */});
        
        return cachedResponse;
      }

      return fetch(event.request).then((response) => {
        // If valid, cache it dynamically (e.g. hashed vite js/css assets)
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      }).catch(() => {
        // Fallback for document pages when offline
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
