/* Service worker for offline-cache + stale-while-revalidate of static
 * assets. Reddit JSON requests are NOT cached here — they go through
 * a separate in-page SWR layer (Reddit.fetchJson) so the user can
 * control freshness via the Refresh / Go button.
 *
 * Strategy:
 *   - Static assets (HTML, CSS, JS, the icons) are served cache-first
 *     with a background fetch that updates the cache for next visit.
 *   - Cross-origin requests (CORS proxies, chart.js CDN) are NOT
 *     intercepted; the browser handles them normally.
 *
 * !!! IMPORTANT WHENEVER YOU SHIP A JS/CSS CHANGE !!!
 * BUMP BOTH numbers in lockstep:
 *   1. CACHE_VERSION below
 *   2. The ?v=YYYYMMDDx query strings in index.html
 *
 * The fetch handler matches with `ignoreSearch: true`, which means a
 * pre-existing service-worker cache will keep serving the OLD bundle
 * even when index.html now references `?v=newer`. The only thing
 * that evicts the old cache is a CACHE_VERSION change here, which
 * triggers the activate handler to delete every `rj-static-*` cache
 * key that doesn't match. Forgetting this leaves users (especially
 * iOS PWA installs, which retain SWs aggressively) stuck on an old
 * UI build until they manually reinstall the app.
 */
const CACHE_VERSION = "v20260518s";
const CACHE_NAME = "rj-static-" + CACHE_VERSION;

const PRECACHE = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/util.js",
  "./js/sync.js",
  "./js/reddit.js",
  "./js/seeds.js",
  "./js/analysis.js",
  "./js/charts.js",
  "./js/campaigns.js",
  "./js/postcache.js",
  "./js/composer.js",
  "./js/ui.js",
  "./js/app.js",
  "./vendor/marked.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    /* addAll fails the whole install if any one URL 404s; do them
     * individually so a missing optional asset doesn't block updates. */
    await Promise.all(PRECACHE.map(async (url) => {
      try { await cache.add(url); } catch (_) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    /* Evict any old cache versions. */
    await Promise.all(keys
      .filter((k) => k.startsWith("rj-static-") && k !== CACHE_NAME)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  /* Only handle same-origin GETs for our static assets. Reddit JSON
   * proxy requests go cross-origin so won't even hit this branch. */
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  /* Match by pathname (ignore ?v= cache-bust). */
  const isHtml  = req.headers.get("accept") && req.headers.get("accept").includes("text/html");
  const isAsset = /\.(css|js|svg|png|jpe?g|webp|woff2?)$/i.test(url.pathname);
  if (!isHtml && !isAsset && url.pathname !== "/" && !url.pathname.endsWith(".html")) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });
    /* Stale-while-revalidate: return cached immediately if we have
     * it, then update the cache in the background for next visit.
     * No cached entry -> fall through to a regular fetch + cache. */
    const networkPromise = fetch(req).then((res) => {
      if (res && res.ok) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => null);

    if (cached) {
      networkPromise.catch(() => {});
      return cached;
    }
    const fresh = await networkPromise;
    return fresh || new Response("Offline — content not in cache yet.", { status: 503, statusText: "Service unavailable", headers: { "Content-Type": "text/plain" } });
  })());
});
