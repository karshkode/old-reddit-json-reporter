/* Service worker for offline use and fast repeat loads.
 *
 * Reddit/archive JSON is NOT cached here — it goes through a separate
 * in-page layer (Reddit.fetchJson) so the user controls freshness with
 * the Refresh button.
 *
 * The strategy exists to solve one problem: a returning visitor must
 * never be served a stale bundle. An earlier version of this file
 * matched every request with `ignoreSearch: true` and relied on a
 * hand-bumped CACHE_VERSION to evict anything. Bumping the `?v=` in
 * index.html therefore did nothing on its own, and the day someone
 * shipped without also editing this file, every existing install
 * froze on the old code until it was manually reinstalled. That is
 * exactly what happened between May and August 2026.
 *
 * So versioning is now load-bearing rather than ceremonial:
 *
 *   - Navigations are network-first. index.html is the manifest that
 *     names which `?v=` of every asset to run, so it is the one file
 *     that must never come from a stale cache. Falls back to the
 *     cached copy when offline.
 *
 *   - Assets carrying a `?v=` are cached under their full URL, query
 *     string included. A new `?v=` is a cache miss and hits the
 *     network by itself, with no help from CACHE_VERSION. Superseded
 *     versions of the same path are pruned as the new one lands.
 *
 *   - Assets without a `?v=` fall back to stale-while-revalidate.
 *
 * The upshot: bumping the `?v=` strings in index.html is sufficient,
 * and forgetting to touch this file is no longer a way to strand
 * users. CACHE_VERSION below is now only a "throw everything away"
 * lever for when the cache format itself changes.
 */
const CACHE_VERSION = "v20260802";
const CACHE_NAME = "rj-static-" + CACHE_VERSION;

const SHELL = "./index.html";

/* Which same-origin assets we are willing to cache. */
const ASSET_RE = /\.(css|js|svg|png|jpe?g|webp|woff2?)$/i;

function isNavigation(req) {
  if (req.mode === "navigate") return true;
  const accept = req.headers.get("accept") || "";
  return accept.includes("text/html");
}

/* Pull the asset list straight out of index.html rather than keeping a
 * second copy of it here. The old hardcoded PRECACHE had drifted badly
 * — it still named files that had been deleted and missed a dozen that
 * had been added — and a precache list that disagrees with the page is
 * worse than none at all. */
function assetsFrom(html) {
  const urls = new Set();
  const re = /(?:src|href)\s*=\s*"(\.\/[^"]+?\.(?:css|js)(?:\?[^"]*)?)"/gi;
  let m;
  while ((m = re.exec(html))) urls.add(m[1]);
  return Array.from(urls);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      /* `reload` so a new worker never seeds itself from the HTTP
       * cache's copy of the previous release. */
      const res = await fetch(SHELL, { cache: "reload" });
      if (res && res.ok) {
        const html = await res.clone().text();
        await cache.put(SHELL, res);
        /* One at a time and failure-tolerant: a single 404 must not
         * abort the install and leave the worker uninstalled. */
        await Promise.all(assetsFrom(html).map(async (url) => {
          try { await cache.add(new Request(url, { cache: "reload" })); } catch (_) {}
        }));
      }
    } catch (_) {
      /* Offline at install time. The fetch handler will fill the
       * cache on the next successful load. */
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith("rj-static-") && k !== CACHE_NAME)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Drop other cached versions of the same path once a new one is in.
 * Without this the cache would accumulate every build ever shipped. */
async function pruneOldVersions(cache, url) {
  const keep = url.href;
  const path = url.origin + url.pathname;
  for (const req of await cache.keys()) {
    if (req.url === keep) continue;
    const u = new URL(req.url);
    if (u.origin + u.pathname === path) await cache.delete(req);
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isNavigation(req)) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (!ASSET_RE.test(url.pathname)) return;

  event.respondWith(url.searchParams.has("v")
    ? versionedAsset(req, url)
    : staleWhileRevalidate(req));
});

/* index.html: fresh whenever the network allows, cached copy when not. */
async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(SHELL, res.clone()).catch(() => {});
    return res;
  } catch (_) {
    const cached = (await cache.match(req)) || (await cache.match(SHELL));
    return cached || offline();
  }
}

/* `?v=`-stamped asset: the URL is the version, so a hit is by
 * definition the right bytes and needs no revalidation. */
async function versionedAsset(req, url) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      await cache.put(req, res.clone());
      pruneOldVersions(cache, url).catch(() => {});
    }
    return res;
  } catch (_) {
    /* An unversioned or differently-versioned copy beats a hard
     * failure when the network is gone. */
    const fallback = await cache.match(req, { ignoreSearch: true });
    return fallback || offline();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  if (cached) return cached;
  return (await network) || offline();
}

function offline() {
  return new Response("Offline — content not in cache yet.", {
    status: 503,
    statusText: "Service unavailable",
    headers: { "Content-Type": "text/plain" },
  });
}
