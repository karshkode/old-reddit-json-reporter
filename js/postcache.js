/* Persistent post cache — keeps `state.posts` on disk so a page
 * reload doesn't have to re-fetch from Reddit before the dashboard
 * is usable.
 *
 * Without this, the user's "I just opened the tab" experience is:
 *   reload -> empty dashboard -> tap Go -> wait 5-30 seconds for
 *   100 * N subs of Reddit JSON to round-trip through the proxy
 *   chain -> finally see anything.
 *
 * With this:
 *   reload -> instant cached view (last refresh was N min ago)
 *   -> tap Refresh -> fresh fetch merged with cache, only the
 *   delta is visible as "+N new posts since last refresh".
 *
 * Storage: localStorage. Up to ~5 MB on Safari/iOS, more on
 * Chrome/Firefox. We gzip-compress payloads above 8 KB to stay
 * comfortably below the cap even with hundreds of posts. The
 * compression happens via the same CompressionStream API used
 * by sync.js, which is supported on every browser >= Safari 16,
 * Chrome 80, Firefox 113. Falls back to plain JSON on older
 * runtimes.
 *
 * Schema (gzipped JSON):
 *   { v: 1,
 *     savedAt: <ms epoch>,
 *     fetchKey: "subs=A,B|listing=hot|time=week|limit=100",
 *     posts: [...] }
 *
 * Cache lifetime is *open-ended* — we don't TTL the whole blob
 * because the user may want to see fall-off-hot posts that haven't
 * appeared in their listing for days. Instead, individual posts
 * are aged out at merge time (default 14 days from `created_utc`).
 */
(function () {
  const Cache = {};
  const KEY_PLAIN = "rj.postCache";
  const KEY_GZIP  = "rj.postCache.gz";
  const VERSION = 1;
  const COMPRESS_THRESHOLD = 8000;       // bytes before we bother gzipping
  const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const POSTS_HARD_CAP = 5000;            // safety: don't try to persist >5000 posts
  Cache.VERSION = VERSION;
  Cache.DEFAULT_MAX_AGE_MS = DEFAULT_MAX_AGE_MS;

  /* ------------------------- low-level helpers ------------------------- */

  function bytesToBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return (typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64"));
  }
  function base64ToBytes(b64) {
    const bin = (typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function gzipString(s) {
    if (typeof CompressionStream === "undefined") return null;
    try {
      const cs = new CompressionStream("gzip");
      const stream = new Blob([s]).stream().pipeThrough(cs);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (_) { return null; }
  }
  async function gunzipBytes(bytes) {
    if (typeof DecompressionStream === "undefined") return null;
    try {
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return await new Response(stream).text();
    } catch (_) { return null; }
  }

  /* ------------------------------ save ------------------------------- */

  Cache.save = async function (posts, opts) {
    if (!Array.isArray(posts) || !posts.length) return false;
    opts = opts || {};
    const data = {
      v: VERSION,
      savedAt: Date.now(),
      fetchKey: String(opts.fetchKey || ""),
      activeSubs: Array.isArray(opts.activeSubs) ? opts.activeSubs.slice() : [],
      posts: posts.slice(0, POSTS_HARD_CAP),
    };
    const json = JSON.stringify(data);
    try {
      if (json.length > COMPRESS_THRESHOLD) {
        const gz = await gzipString(json);
        if (gz) {
          localStorage.setItem(KEY_GZIP, bytesToBase64(gz));
          /* Drop the plain entry so we don't double-store. */
          try { localStorage.removeItem(KEY_PLAIN); } catch (_) {}
          return true;
        }
      }
      localStorage.setItem(KEY_PLAIN, json);
      try { localStorage.removeItem(KEY_GZIP); } catch (_) {}
      return true;
    } catch (e) {
      /* QuotaExceededError on iOS Safari = drop the cache rather
       * than leave a half-written entry. The user just won't get a
       * cached view next reload, which is the existing behavior. */
      console.warn("[postcache] save failed:", e && e.message);
      try { localStorage.removeItem(KEY_PLAIN); } catch (_) {}
      try { localStorage.removeItem(KEY_GZIP); } catch (_) {}
      return false;
    }
  };

  /* ------------------------------ load ------------------------------- */

  Cache.load = async function () {
    try {
      const gz = (typeof localStorage !== "undefined") ? localStorage.getItem(KEY_GZIP) : null;
      if (gz) {
        const json = await gunzipBytes(base64ToBytes(gz));
        if (json) {
          const parsed = JSON.parse(json);
          if (parsed && parsed.v === VERSION) return parsed;
        }
      }
      const raw = (typeof localStorage !== "undefined") ? localStorage.getItem(KEY_PLAIN) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.v === VERSION) return parsed;
      }
    } catch (e) {
      console.warn("[postcache] load failed:", e && e.message);
    }
    return null;
  };

  /* ------------------------------ clear ------------------------------ */

  Cache.clear = function () {
    try { if (typeof localStorage !== "undefined") localStorage.removeItem(KEY_PLAIN); } catch (_) {}
    try { if (typeof localStorage !== "undefined") localStorage.removeItem(KEY_GZIP); } catch (_) {}
  };

  /* ----------------------------- merge ------------------------------- *
   * Combine a fresh fetch with the previously-cached pool so users keep
   * seeing posts that fell off the front-page listing without having
   * to re-fetch the whole tail.
   *
   * Rules:
   *   - For posts present in BOTH cached and fresh: use the FRESH copy
   *     (newer score / comments / removed-flag).
   *   - For posts present only in cached: keep them IF they're in the
   *     active-sub set AND younger than maxAgeMs (default 14 days).
   *   - For posts only in fresh: keep them all (the listing the user
   *     just queried defines what's in scope).
   *
   * Returns { posts, kept, dropped, replaced, totalCached, totalFresh }
   * for diagnostic logging / status bar text.
   */
  Cache.merge = function (cached, fresh, opts) {
    opts = opts || {};
    const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
    const activeSubsLower = (opts.activeSubs || []).map((s) => String(s).toLowerCase());
    const activeSet = activeSubsLower.length ? new Set(activeSubsLower) : null;
    const now = Date.now();

    const map = new Map();
    let replaced = 0;

    /* Fresh first — they win on conflict. */
    for (const p of fresh || []) {
      if (p && p.id) map.set(p.id, p);
    }

    let kept = 0;
    let droppedAge = 0;
    let droppedSub = 0;
    for (const p of cached || []) {
      if (!p || !p.id) continue;
      if (map.has(p.id)) { replaced++; continue; }
      if (activeSet) {
        const sub = String(p.subreddit || "").toLowerCase();
        if (sub && !activeSet.has(sub)) { droppedSub++; continue; }
      }
      const createdMs = p.created_utc ? Number(p.created_utc) * 1000 : 0;
      if (createdMs && (now - createdMs) > maxAgeMs) { droppedAge++; continue; }
      map.set(p.id, p);
      kept++;
    }
    return {
      posts: Array.from(map.values()),
      kept,
      droppedAge,
      droppedSub,
      replaced,
      totalCached: (cached || []).length,
      totalFresh: (fresh || []).length,
    };
  };

  /* ------------------------- fetch-key helper ------------------------ */

  /* Build a deterministic key describing the fetch parameters that
   * produced a cached pool. Used to detect "filters changed since
   * cache was saved" so the dashboard can hint that a Refresh is
   * worth doing. */
  Cache.buildFetchKey = function (subs, listing, timeWindow, limit) {
    const subList = Array.isArray(subs) ? subs.slice().map(String).sort().join(",") : String(subs || "");
    return `subs=${subList}|listing=${listing || ""}|time=${timeWindow || ""}|limit=${limit || ""}`;
  };

  /* Filter cached posts to a given active-sub set without merging. Used
   * during initial hydration where there's no fresh-fetch to merge
   * against — we just want to surface the cached posts that match the
   * user's currently-active filter. */
  Cache.filterByActiveSubs = function (cached, activeSubs) {
    if (!Array.isArray(cached) || !cached.length) return [];
    if (!Array.isArray(activeSubs) || !activeSubs.length) return cached.slice();
    const set = new Set(activeSubs.map((s) => String(s).toLowerCase()));
    return cached.filter((p) => p && p.subreddit && set.has(String(p.subreddit).toLowerCase()));
  };

  /* ------------------------- relative time ---------------------------
   * "12 min ago" / "2 h ago" / "yesterday at 3:14 PM" — driven from
   * the savedAt millisecond stamp in the cache payload. Same pattern
   * Util.js has elsewhere for post timestamps; copied here so the
   * cache module is self-contained and doesn't depend on Util being
   * loaded first.
   * ------------------------------------------------------------- */
  Cache.formatAge = function (savedAt) {
    if (!savedAt) return "";
    const elapsed = Math.max(0, Date.now() - Number(savedAt));
    const sec = Math.floor(elapsed / 1000);
    if (sec < 30) return "just now";
    if (sec < 90) return "1 min ago";
    if (sec < 3600) return Math.floor(sec / 60) + " min ago";
    if (sec < 86400) return Math.floor(sec / 3600) + " h ago";
    if (sec < 86400 * 2) return "yesterday";
    return Math.floor(sec / 86400) + " days ago";
  };

  if (typeof window !== "undefined") window.PostCache = Cache;
  if (typeof module !== "undefined" && module.exports) module.exports = Cache;
})();
