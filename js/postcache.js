/* Persistent post cache — keeps `state.posts` on disk so a page
 * reload doesn't have to re-fetch from Reddit before the dashboard
 * is usable.
 *
 * Without this, the user's "I just opened the tab" experience is:
 *   reload -> empty dashboard -> tap Go -> wait 5-30 seconds for
 *   100 * N subs of Reddit JSON to come back from the archive ->
 *   finally see anything.
 *
 * With this:
 *   reload -> instant cached view (last refresh was N min ago)
 *   -> tap Refresh -> fresh fetch merged with cache, only the
 *   delta is visible as "+N new posts since last refresh".
 *
 * STORAGE BACKEND: IndexedDB (primary) + localStorage (fallback)
 *
 *   At ~99 subs * 100 posts = ~10,000 fresh posts per refresh,
 *   localStorage's ~5 MB iOS quota becomes the bottleneck (raw
 *   JSON for 10,000 posts is ~10-20 MB, gzipped to ~3-5 MB).
 *   IndexedDB has effectively unlimited quota on every modern
 *   browser (50% of disk space on Chrome/Edge, 1 GB+ on Firefox,
 *   500 MB+ on Safari) so 50,000+ post caches comfortably fit.
 *
 *   IDB is the primary path. localStorage with gzip is the
 *   fallback for environments that lack IDB (vanishingly rare —
 *   Safari has had IDB since iOS 8). On first load with the new
 *   code, any existing localStorage cache is automatically
 *   migrated to IDB and the localStorage entries are deleted to
 *   free space.
 *
 * Schema (stored as a structured-clone object in IDB; gzipped
 * JSON in the LS fallback):
 *   { v: 2,
 *     savedAt: <ms epoch>,
 *     fetchKey: "subs=A,B|listing=hot|time=week|limit=100",
 *     activeSubs: ["A", "B", ...],
 *     posts: [...] }
 *
 * Cache lifetime is open-ended — we don't TTL the whole blob
 * because the user may want to see fall-off-hot posts that haven't
 * appeared in their listing for days. Individual posts are aged
 * out at merge time (default 14 days from `created_utc`).
 */
(function () {
  const Cache = {};

  /* IndexedDB layout. One DB, one object store, one fixed key. */
  const DB_NAME = "rj-postcache";
  const DB_VERSION = 1;
  const STORE = "blob";
  const IDB_KEY = "current";

  /* localStorage fallback keys. Same names as v1 of this module so
   * an existing cache is detected for migration on first load. */
  const LS_KEY_PLAIN = "rj.postCache";
  const LS_KEY_GZIP  = "rj.postCache.gz";

  const VERSION = 2;
  const COMPRESS_THRESHOLD = 8000;
  const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  /* 50,000 posts. At ~99 subs * 100 fresh posts per refresh and
   * a 14-day age cap, this leaves ample headroom for the merged
   * pool to grow over weeks of regular use. IndexedDB's quota
   * comfortably fits this even with all the metadata. */
  const POSTS_HARD_CAP = 50000;

  Cache.VERSION = VERSION;
  Cache.DEFAULT_MAX_AGE_MS = DEFAULT_MAX_AGE_MS;
  Cache.POSTS_HARD_CAP = POSTS_HARD_CAP;

  let migrationDone = false;

  /* ============================================================
   * IndexedDB helpers
   *
   * Tiny one-shot wrappers — open, txn, close. We don't keep a
   * long-lived db handle because the cache is read once at boot
   * and written once per refresh; the open cost (single-digit ms)
   * is dwarfed by the structured-clone serialization.
   * ============================================================ */

  function idbAvailable() {
    try { return typeof indexedDB !== "undefined" && indexedDB; }
    catch (_) { return false; }
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!idbAvailable()) return reject(new Error("indexedDB unavailable"));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
      req.onblocked = () => reject(new Error("indexedDB open blocked"));
    });
  }

  async function idbSave(payload) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(payload, IDB_KEY);
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error || new Error("idb save aborted")); };
      } catch (e) { db.close(); reject(e); }
    });
  }

  async function idbLoad() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(IDB_KEY);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror  = () => { db.close(); reject(req.error); };
      } catch (e) { db.close(); reject(e); }
    });
  }

  async function idbClear() {
    if (!idbAvailable()) return;
    let db;
    try { db = await openDb(); } catch (_) { return; }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(IDB_KEY);
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); resolve(false); };
      } catch (_) { db.close(); resolve(false); }
    });
  }

  /* ============================================================
   * localStorage fallback (gzip-compressed JSON)
   *
   * Used when IDB is unavailable AND for migration of v1 caches
   * written by the previous release of this module.
   * ============================================================ */

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

  async function lsSave(payload) {
    if (typeof localStorage === "undefined") return false;
    const json = JSON.stringify(payload);
    try {
      if (json.length > COMPRESS_THRESHOLD) {
        const gz = await gzipString(json);
        if (gz) {
          localStorage.setItem(LS_KEY_GZIP, bytesToBase64(gz));
          try { localStorage.removeItem(LS_KEY_PLAIN); } catch (_) {}
          return true;
        }
      }
      localStorage.setItem(LS_KEY_PLAIN, json);
      try { localStorage.removeItem(LS_KEY_GZIP); } catch (_) {}
      return true;
    } catch (e) {
      console.warn("[postcache] LS save failed:", e && e.message);
      try { localStorage.removeItem(LS_KEY_PLAIN); } catch (_) {}
      try { localStorage.removeItem(LS_KEY_GZIP); } catch (_) {}
      return false;
    }
  }

  async function lsLoad() {
    if (typeof localStorage === "undefined") return null;
    try {
      const gz = localStorage.getItem(LS_KEY_GZIP);
      if (gz) {
        const json = await gunzipBytes(base64ToBytes(gz));
        if (json) return JSON.parse(json);
      }
      const raw = localStorage.getItem(LS_KEY_PLAIN);
      if (raw) return JSON.parse(raw);
    } catch (e) { console.warn("[postcache] LS load failed:", e && e.message); }
    return null;
  }

  function lsClear() {
    if (typeof localStorage === "undefined") return;
    try { localStorage.removeItem(LS_KEY_PLAIN); } catch (_) {}
    try { localStorage.removeItem(LS_KEY_GZIP); } catch (_) {}
  }

  /* ============================================================
   * One-time migration: v1 cache lived in localStorage. On first
   * load with v2 code, copy it to IndexedDB and clear the LS
   * entries so the user reclaims that 5 MB of quota.
   * ============================================================ */

  async function migrateLsToIdbIfNeeded() {
    if (migrationDone) return;
    migrationDone = true;
    if (!idbAvailable()) return;
    let existingIdb;
    try { existingIdb = await idbLoad(); } catch (_) { existingIdb = null; }
    if (existingIdb) return;  /* IDB already has data; nothing to migrate */
    const fromLs = await lsLoad();
    if (!fromLs) return;
    /* Re-tag with current schema version so downstream readers
     * don't see a v1 marker and bail. The v1 schema is a strict
     * subset of v2 (just no activeSubs field on some saves), so a
     * direct copy works. */
    fromLs.v = VERSION;
    try {
      await idbSave(fromLs);
      lsClear();
      console.log("[postcache] migrated v1 LS cache -> IDB (" +
        ((fromLs.posts && fromLs.posts.length) || 0) + " posts)");
    } catch (e) {
      console.warn("[postcache] LS->IDB migration failed:", e && e.message);
    }
  }

  /* ============================================================
   * Public API
   *
   * Save / load / clear all use the IDB-first, LS-fallback flow.
   * Callers don't have to know which backend is active.
   * ============================================================ */

  Cache.save = async function (posts, opts) {
    if (!Array.isArray(posts) || !posts.length) return false;
    opts = opts || {};
    const payload = {
      v: VERSION,
      savedAt: Date.now(),
      fetchKey: String(opts.fetchKey || ""),
      activeSubs: Array.isArray(opts.activeSubs) ? opts.activeSubs.slice() : [],
      posts: posts.length > POSTS_HARD_CAP ? posts.slice(0, POSTS_HARD_CAP) : posts,
    };

    if (idbAvailable()) {
      try {
        await idbSave(payload);
        /* Belt-and-suspenders: if a stale LS cache from v1 still
         * exists, drop it now that we've successfully written to
         * IDB. This is also done by migrateLsToIdbIfNeeded but
         * that only runs once per process. */
        lsClear();
        return true;
      } catch (e) {
        /* QuotaExceededError or version conflict — fall through to
         * the LS path. The user just won't get a cache larger than
         * LS can hold, but they'll still get *something*. */
        console.warn("[postcache] IDB save failed, falling back to LS:", e && e.message);
      }
    }
    return lsSave(payload);
  };

  Cache.load = async function () {
    await migrateLsToIdbIfNeeded();
    if (idbAvailable()) {
      try {
        const v = await idbLoad();
        if (v && (v.v === VERSION || v.v === 1)) return v;
      } catch (e) {
        console.warn("[postcache] IDB load failed, falling back to LS:", e && e.message);
      }
    }
    const ls = await lsLoad();
    if (ls && (ls.v === VERSION || ls.v === 1)) return ls;
    return null;
  };

  Cache.clear = async function () {
    /* Always clear BOTH backends so a Full reset is comprehensive
     * regardless of which one the runtime ended up using. */
    try { await idbClear(); } catch (_) {}
    lsClear();
  };

  /* Synchronous variant for callers that can't await (e.g. the
   * Full reset button handler that wants the UI to reflect the
   * wipe immediately). The IDB clear fires fire-and-forget. */
  Cache.clearSync = function () {
    if (idbAvailable()) { idbClear().catch(() => {}); }
    lsClear();
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
   *   - For posts only in fresh: keep them all.
   *
   * Returns { posts, kept, droppedAge, droppedSub, replaced,
   *           totalCached, totalFresh } for diagnostic logging.
   */
  Cache.merge = function (cached, fresh, opts) {
    opts = opts || {};
    const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
    const activeSubsLower = (opts.activeSubs || []).map((s) => String(s).toLowerCase());
    const activeSet = activeSubsLower.length ? new Set(activeSubsLower) : null;
    const now = Date.now();

    const map = new Map();
    let replaced = 0;

    for (const p of fresh || []) {
      if (p && p.id) map.set(p.id, p);
    }

    let kept = 0;
    let droppedAge = 0;
    let droppedSub = 0;
    for (const p of cached || []) {
      if (!p || !p.id) continue;
      if (map.has(p.id)) { replaced++; continue; }
      /* A post the user pasted in by hand is theirs, not a by-product
       * of which subreddits happen to be loaded. Unloading the sub it
       * came from, or letting it get old, must not silently delete it
       * from the inventory they added it to. */
      if (activeSet && !p.imported) {
        const sub = String(p.subreddit || "").toLowerCase();
        if (sub && !activeSet.has(sub)) { droppedSub++; continue; }
      }
      const createdMs = p.created_utc ? Number(p.created_utc) * 1000 : 0;
      if (!p.imported && createdMs && (now - createdMs) > maxAgeMs) { droppedAge++; continue; }
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

  /* ----------------------------- patch ------------------------------- *
   * Fold a freshly-fetched subset back into a pool without judging the
   * rest of it.
   *
   * merge() answers "here is everything I just fetched, what should the
   * whole inventory be" — so anything it was not handed is a candidate
   * for eviction. A scoped sync asks the opposite question: only these
   * few posts were looked at, leave every other post exactly where it
   * is. Running merge() for one subreddit's refresh would age out the
   * other hundred and seventy.
   *
   * The counts come back because a scoped sync is small enough to
   * report honestly. "12 new, 40 updated, +1.2k upvotes" is the whole
   * point of syncing one thing rather than everything.
   */
  Cache.patch = function (existing, fresh) {
    const order = [];
    const map = new Map();
    for (const p of existing || []) {
      if (!p || !p.id) continue;
      if (!map.has(p.id)) order.push(p.id);
      map.set(p.id, p);
    }

    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let scoreDelta = 0;
    let commentDelta = 0;
    const changedIds = [];

    for (const p of fresh || []) {
      if (!p || !p.id) continue;
      const prev = map.get(p.id);
      if (!prev) {
        order.push(p.id);
        map.set(p.id, p);
        added++;
        continue;
      }
      /* A post the user pasted in by hand carries flags the archive
       * knows nothing about. Re-fetching it must not quietly demote it
       * back to an ordinary listing post and let the next merge drop
       * it. */
      const next = p.imported || !prev.imported ? p : Object.assign({}, p, { imported: true });
      const ds = (next.score || 0) - (prev.score || 0);
      const dc = (next.num_comments || 0) - (prev.num_comments || 0);
      map.set(p.id, next);
      if (ds || dc || next.removed !== prev.removed) {
        updated++;
        scoreDelta += ds;
        commentDelta += dc;
        changedIds.push(p.id);
      } else {
        unchanged++;
      }
    }

    return {
      posts: order.map((id) => map.get(id)),
      added,
      updated,
      unchanged,
      scoreDelta,
      commentDelta,
      changedIds,
      totalFresh: (fresh || []).length,
    };
  };

  /* ------------------------- fetch-key helper ------------------------ */

  Cache.buildFetchKey = function (subs, listing, timeWindow, limit) {
    const subList = Array.isArray(subs) ? subs.slice().map(String).sort().join(",") : String(subs || "");
    return `subs=${subList}|listing=${listing || ""}|time=${timeWindow || ""}|limit=${limit || ""}`;
  };

  Cache.filterByActiveSubs = function (cached, activeSubs) {
    if (!Array.isArray(cached) || !cached.length) return [];
    const real = cached.filter((p) =>
      p && !p.syndicated && String(p.id || "").indexOf("art_") !== 0
    );
    if (!Array.isArray(activeSubs) || !activeSubs.length) return real.slice();
    const set = new Set(activeSubs.map((s) => String(s).toLowerCase()));
    /* Hand-added Reddit posts survive regardless of which subs are
     * loaded — see the note in Cache.merge. Syndicated drafts do not. */
    return real.filter((p) => p.imported || (p.subreddit && set.has(String(p.subreddit).toLowerCase())));
  };

  /* ------------------------- relative time ----------------------- */

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

  /* ------------------------- backend probe ----------------------- *
   * Lets the dashboard surface "Storage: IndexedDB" / "Storage:
   * localStorage" / "Storage: in-memory only" in the cache-age
   * banner so a user debugging a quota issue can see at a glance
   * which path is active. */
  Cache.activeBackend = function () {
    if (idbAvailable()) return "indexeddb";
    if (typeof localStorage !== "undefined") return "localstorage";
    return "none";
  };

  if (typeof window !== "undefined") window.PostCache = Cache;
  if (typeof module !== "undefined" && module.exports) module.exports = Cache;
})();
