/* Campaign manager.
 *
 * A campaign = { id, name, goalScore, goalComments, postIds[], createdAt }.
 *
 * Storage strategy: maintain an in-memory mirror as the source of truth for
 * the page session, and try to persist it to localStorage. If persistence
 * fails (iOS Safari Private Browsing, "Block All Cookies", quota exceeded,
 * embedded WebView with storage disabled), the in-memory list still works
 * inside this tab and `Campaigns.persistError` records why.
 *
 * This guards against the previous failure mode where `localStorage.setItem`
 * threw synchronously and silently inside `Campaigns.add`, destroying any
 * record of the just-created campaign.
 */
(function () {
  const KEY = "rj.campaigns";
  /* Compressed-blob key (PR 7). When the JSON is large we store a
   * gzip+base64url payload here instead of the plain-text KEY, to fit
   * within the ~5MB localStorage quota even with hundreds of post IDs
   * across many campaigns. The plain-text KEY is cleared in that case
   * so we don't double-store. Reads check both keys. */
  const KEY_GZIP = "rj.campaigns.gz";
  const COMPRESS_THRESHOLD = 8 * 1024;     /* compress when JSON > 8KB */
  const Campaigns = {};

  let mirror = null;
  let persistError = null;

  /* ---------- Compression helpers (PR 7) ---------- */
  function utf8Encode(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    const bin = unescape(encodeURIComponent(s));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8Decode(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(bin));
  }
  function bytesToBase64Url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function base64UrlToBytes(s) {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function gzip(bytes) {
    if (typeof CompressionStream === "undefined") return null;
    try {
      const cs = new CompressionStream("gzip");
      const stream = new Blob([bytes]).stream().pipeThrough(cs);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (_) { return null; }
  }
  async function gunzip(bytes) {
    if (typeof DecompressionStream === "undefined") return null;
    try {
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (_) { return null; }
  }

  function loadFromStorage() {
    try {
      /* Plain-text path first (faster, no async). */
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      }
      /* Compressed path. Decoded synchronously by deferring to
       * loadCompressedFromStorage which uses async DecompressionStream
       * but returns a Promise. Because callers expect sync today, we
       * fall back to an empty list and kick off the async hydrate. */
      const gz = localStorage.getItem(KEY_GZIP);
      if (gz) {
        hydrateFromCompressed(gz);
        return [];  /* replaced once hydrate resolves */
      }
      return [];
    } catch (e) {
      persistError = e && e.message ? e.message : String(e);
      return [];
    }
  }
  async function hydrateFromCompressed(gzBase64) {
    try {
      const bytes = base64UrlToBytes(gzBase64);
      const decompressed = await gunzip(bytes);
      if (!decompressed) return;
      const json = utf8Decode(decompressed);
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) {
        mirror = parsed;
        if (typeof Campaigns.onHydrate === "function") {
          try { Campaigns.onHydrate(parsed); } catch (_) {}
        }
      }
    } catch (e) {
      persistError = e && e.message ? e.message : String(e);
    }
  }

  function ensureMirror() {
    if (mirror === null) mirror = loadFromStorage();
    return mirror;
  }

  function persist() {
    try {
      const json = JSON.stringify(mirror);
      /* Below threshold -> plain-text for instant reads. */
      if (json.length < COMPRESS_THRESHOLD) {
        localStorage.setItem(KEY, json);
        try { localStorage.removeItem(KEY_GZIP); } catch (_) {}
        persistError = null;
        return true;
      }
      /* Above threshold -> kick off async compression and store
       * both keys so reads (which run synchronously today) still
       * see SOMETHING immediately. */
      localStorage.setItem(KEY, json);
      persistError = null;
      persistCompressed(json).catch((e) => {
        console.warn("[campaigns] compression failed:", e && e.message);
      });
      return true;
    } catch (e) {
      persistError = e && e.message ? e.message : String(e);
      /* Plain-text write failed (likely quota). Try compressed-only. */
      persistCompressed(JSON.stringify(mirror)).catch(() => {});
      return false;
    }
  }
  async function persistCompressed(json) {
    if (typeof CompressionStream === "undefined") return;
    const bytes = utf8Encode(json);
    const gz = await gzip(bytes);
    if (!gz) return;
    /* Only swap to gzip storage when it actually saves space. */
    if (gz.length >= bytes.length * 0.9) return;
    try {
      localStorage.setItem(KEY_GZIP, bytesToBase64Url(gz));
      /* Drop the plain-text copy ONLY if the gzip write succeeded
       * (otherwise we'd lose data on quota errors). */
      localStorage.removeItem(KEY);
      persistError = null;
    } catch (e) {
      persistError = e && e.message ? e.message : String(e);
    }
  }

  Campaigns.canPersist = function () {
    /* Probe localStorage with a short throwaway key. Catches:
     * - Private Browsing on older Safari (throws)
     * - Cookies blocked / storage disabled (throws SecurityError)
     * - Quota exceeded
     */
    try {
      const k = "rj.probe." + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(k, "1");
      const ok = localStorage.getItem(k) === "1";
      localStorage.removeItem(k);
      return ok;
    } catch (_) {
      return false;
    }
  };

  Campaigns.persistErrorMessage = function () { return persistError; };

  Campaigns.list = function () { return ensureMirror().slice(); };

  Campaigns.add = function (data) {
    ensureMirror();
    const id = Math.random().toString(36).slice(2, 10);
    const c = {
      id,
      name: String(data && data.name || "Untitled campaign"),
      goalScore: Number(data && data.goalScore) || 0,
      goalComments: Number(data && data.goalComments) || 0,
      postIds: Util.uniqBy(((data && data.postIds) || []).map(String), (x) => x),
      createdAt: Date.now(),
    };
    mirror.push(c);
    persist();
    return c;
  };

  Campaigns.remove = function (id) {
    ensureMirror();
    mirror = mirror.filter((c) => c.id !== id);
    persist();
  };

  Campaigns.get = function (id) {
    return ensureMirror().find((c) => c.id === id) || null;
  };

  Campaigns.update = function (id, patch) {
    ensureMirror();
    const i = mirror.findIndex((c) => c.id === id);
    if (i < 0) return null;
    mirror[i] = Object.assign({}, mirror[i], patch);
    persist();
    return mirror[i];
  };

  /* Append post IDs to an existing campaign, deduping against the
   * existing list. Returns { campaign, added } where `added` is the
   * count of IDs that were actually new. */
  Campaigns.addPostIds = function (id, idsToAdd) {
    ensureMirror();
    const i = mirror.findIndex((c) => c.id === id);
    if (i < 0) return null;
    const existing = new Set(mirror[i].postIds);
    const merged = mirror[i].postIds.slice();
    /* Track WHICH ids are new vs duplicates so the UI can echo
     * the new IDs back to the user as confirmation chips. Without
     * this, a stuck-feeling user (paste, click Add, see a toast,
     * miss it, look at the still-failing campaign) had no easy
     * way to verify their paste actually landed. */
    const addedIds = [];
    for (const newId of (idsToAdd || []).map(String).filter(Boolean)) {
      if (!existing.has(newId)) {
        existing.add(newId);
        merged.push(newId);
        addedIds.push(newId);
      }
    }
    mirror[i] = Object.assign({}, mirror[i], { postIds: merged });
    persist();
    return { campaign: mirror[i], added: addedIds.length, addedIds };
  };

  /* Remove post IDs from a campaign. Returns { campaign, removed }. */
  Campaigns.removePostIds = function (id, idsToRemove) {
    ensureMirror();
    const i = mirror.findIndex((c) => c.id === id);
    if (i < 0) return null;
    const removeSet = new Set((idsToRemove || []).map(String));
    const filtered = mirror[i].postIds.filter((pid) => !removeSet.has(pid));
    const removed = mirror[i].postIds.length - filtered.length;
    mirror[i] = Object.assign({}, mirror[i], { postIds: filtered });
    persist();
    return { campaign: mirror[i], removed };
  };

  /* Fetch live aggregated data for a campaign.
   *
   * If the caller passes options.fromPosts (typically the dashboard's
   * already-loaded subreddit posts) we resolve as many campaign IDs as
   * possible from that local cache before going to the network. The
   * remaining IDs are fetched via Reddit.fetchPostsByIds, which itself
   * falls back to per-ID /comments lookups if /by_id fails.
   *
   * options.skipNetwork = true returns just the local matches (useful for
   * an instant first paint before a slow refresh). */
  Campaigns.fetchAggregated = async function (campaign, options) {
    options = options || {};
    const localPosts = Array.isArray(options.fromPosts) ? options.fromPosts : [];
    const idSet = new Set(campaign.postIds);
    const localById = new Map();
    for (const p of localPosts) {
      if (p && p.id && idSet.has(p.id)) localById.set(p.id, p);
    }
    const knownPosts = Array.from(localById.values());
    const idsToFetch = campaign.postIds.filter((id) => !localById.has(id));

    let fetched = [];
    let networkError = null;
    if (!options.skipNetwork && idsToFetch.length) {
      fetched = await Reddit.fetchPostsByIds(idsToFetch);
      /* fetchPostsByIds attaches the last transport error as a
       * non-enumerable _lastError when EVERY ID failed to resolve.
       * Surface it so the campaign-detail UI can show
       * 'all proxies down: codetabs(empty body) · ...' rather than
       * just an opaque 'Could not resolve' list. */
      if (fetched.length === 0 && fetched._lastError) {
        networkError = fetched._lastError.message || String(fetched._lastError);
      }
    }

    /* Merge local + fetched, then dedupe by id. */
    const seen = new Set();
    const posts = [];
    for (const p of [...knownPosts, ...fetched]) {
      if (p && !seen.has(p.id)) { seen.add(p.id); posts.push(p); }
    }

    const totalScore = posts.reduce((a, b) => a + (b.score || 0), 0);
    const totalComments = posts.reduce((a, b) => a + (b.num_comments || 0), 0);
    const totalAwards = posts.reduce((a, b) => a + (b.total_awards || 0), 0);
    const totalViews = posts.reduce((a, b) => a + (b.view_count || 0), 0);
    const subs = Array.from(new Set(posts.map((p) => p.subreddit))).filter(Boolean);
    const missing = campaign.postIds.filter((id) => !posts.find((p) => p.id === id));
    return {
      posts, totalScore, totalComments, totalAwards, totalViews,
      subs, missing, networkError,
      resolvedFromLocal: knownPosts.length,
      resolvedFromNetwork: fetched.length,
      progressScore: campaign.goalScore ? Math.min(1, totalScore / campaign.goalScore) : null,
      progressComments: campaign.goalComments ? Math.min(1, totalComments / campaign.goalComments) : null,
    };
  };

  /* Manual import / export — useful when storage is broken so the user
   * can copy their campaigns to a note app or another device. */
  Campaigns.exportJson = function () {
    return JSON.stringify(ensureMirror(), null, 2);
  };
  Campaigns.importJson = function (text) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("expected an array");
      mirror = parsed;
      persist();
      return true;
    } catch (_) { return false; }
  };

  window.Campaigns = Campaigns;
})();
