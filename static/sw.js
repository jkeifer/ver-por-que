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
    const url = new URL(request.url);
    if (!CACHEABLE_ORIGINS.includes(url.origin)) {
        return;
    }
    // The app shell (navigations) and the wheel manifest are the unhashed URLs
    // whose content changes across deploys: they MUST be network-first, with
    // the cache only as the offline fallback. Served cache-first, a client
    // that warmed the cache once would be pinned to that build forever -- the
    // cached shell re-registers its own old sw.js?v=<commit>, which keeps
    // serving the cached shell. Everything else (hashed vite assets, versioned
    // wheels, pyodide CDN files) is immutable per URL, so cache-first is safe.
    const networkFirst =
        request.mode === 'navigate' || url.pathname.endsWith('/vendor/manifest.json');
    event.respondWith(
        (async () => {
            const cache = await self.caches.open(CACHE);
            if (networkFirst) {
                try {
                    const response = await fetch(request);
                    if (response.ok) {
                        await cache.put(request, response.clone());
                    }
                    return response;
                } catch (error) {
                    const cached = await cache.match(request);
                    if (cached) {
                        return cached;
                    }
                    throw error;
                }
            }
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
