/**
 * Offline cache -- hand-written, no workbox. Runtime cache-first for the app
 * shell, the vendored wheels, and the pyodide CDN runtime (which micropip
 * resolves dynamically, so there is no precache list -- we keep whatever the
 * first warm load actually fetches). Offline reloads then serve from cache.
 *
 * The page registers us as `sw.js?v=<commit>`, so a new build gets a new
 * script URL (forcing an update) and a fresh, versioned cache; activate()
 * purges the caches from older versions.
 */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `vpq-${VERSION}`;

// Origins whose GETs we persist: same-origin is the app shell + /vendor/;
// jsdelivr is the pyodide runtime and the wheels micropip pulls at boot.
const CACHEABLE_ORIGINS = [self.location.origin, 'https://cdn.jsdelivr.net'];

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        (async () => {
            const names = await self.caches.keys();
            await Promise.all(
                names
                    .filter(name => name.startsWith('vpq-') && name !== CACHE)
                    .map(name => self.caches.delete(name))
            );
            await self.clients.claim();
        })()
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    // Only full GETs to our own origins. Range reads (remote parquet pulled in
    // place) and arbitrary URLs the user pastes go straight to the network.
    if (request.method !== 'GET' || request.headers.has('range')) {
        return;
    }
    if (!CACHEABLE_ORIGINS.includes(new URL(request.url).origin)) {
        return;
    }
    event.respondWith(
        (async () => {
            const cache = await self.caches.open(CACHE);
            const cached = await cache.match(request);
            if (cached) {
                return cached;
            }
            const response = await fetch(request);
            // Cache full successes and opaque cross-origin bodies; skip partials.
            if (response.ok || response.type === 'opaque') {
                await cache.put(request, response.clone());
            }
            return response;
        })()
    );
});
