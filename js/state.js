/* =====================================================================
 * APPLICATION STATE
 * ---------------------------------------------------------------------
 * One mutable object plus its persistence rules. Extracted from app.js
 * so the orchestrator is about wiring rather than bookkeeping, and so
 * the view modules can read state without importing the whole app.
 *
 * Persisted keys all live under the `rj.` prefix. Anything device-local
 * and ephemeral (sort order, page index, current search) is deliberately
 * NOT persisted or synced — restoring it across devices is more
 * surprising than useful.
 * ===================================================================== */
(function () {
  const KEYS = {
    subs: "rj.subs",
    active: "rj.active",
    listing: "rj.listing",
    time: "rj.time",
    limit: "rj.limit",
    spheres: "rj.activeSpheres",
    subSync: "rj.subSync",
    postingAvail: "rj.postingAvail",
  };

  const state = {
    /* ---- Data scope ---- */
    knownSubs: [],
    activeSubs: new Set(),
    listing: "hot",
    timeWindow: "week",
    limit: 100,

    /* ---- Loaded data ---- */
    posts: [],
    detailCache: new Map(),
    /* post id -> Discovery.forPost result. Matching one post is a few
     * dozen about.json reads, so the answer is worth keeping for as
     * long as the tab lives. */
    postRelated: new Map(),
    /* post id -> Analysis.summarizeAudience(...) from fetched comments.
     * Title/body keywords stay on Discovery; this is reception tone and
     * what the thread actually talked about in that subreddit. */
    audienceByPost: new Map(),
    /* post id -> { text, source: caption|ocr, at } from ImageText.ensure */
    imageTextByPost: new Map(),
    subProfiles: {},
    crossPosts: [],
    campaignSummaries: {},

    /* ---- Posts explorer ---- */
    sortKey: "score",
    sortDir: "desc",
    postIdFilter: [],
    searchQuery: "",
    postsPage: 0,
    postsPageSize: 25,
    postsSubFilter: "",
    postsScoreMin: 0,

    /* ---- Dashboard ---- */
    /* summary | timing | charts | themes | communities | crossposts */
    dashSection: "recommend",
    /* Mobile Recommend sub-panel: posts | syndicate | crossposts */
    recommendPanel: "posts",
    timelineMode: "lines", /* lines | stacked | density | total */
    timelineWindow: "7d",  /* 1d | 3d | 7d | 30d | 90d | 1y | all | auto */

    /* ---- Cross-posts ---- */
    crossPostsPage: 0,
    crossPostsPageSize: 10,
    crossPostsSubFilter: "",
    crossPostsSearchQuery: "",
    crossPostsMinSpread: 0,

    /* ---- Discovery ---- */
    discoverStrict: true,
    activeSpheres: [],
    lastDiscoverResult: null,
    lastDiscoverCtx: null,
    recommend: {
      discover: {
        new: { page: 0, pageSize: 25 },
        already: { page: 0, pageSize: 25 },
      },
    },

    /* ---- Campaign workspace ---- */
    openCampaignId: null,
    campaignSection: "plan",
    campaignDeep: null,
    campaignAgg: null,
    campaignSubWindow: "all",
    watchedCampaignId: null,

    /* ---- Communities view ---- */
    communitiesTab: "search",
    communitiesQuery: "",
    communitiesResults: [],
    catalogFilter: "issue", /* issue | audience | state */

    /* ---- Fetch lifecycle ---- */
    pendingChanges: true,
    /* What kind of change made the data stale. "settings" means the
     * listing, window or limit moved, which invalidates every sub at
     * once and can only be answered by a full fetch. "subs" means the
     * loaded set changed — the existing subs' posts are still perfectly
     * good and only the new names need reading. Conflating the two is
     * why adding one subreddit to a hundred and seventy used to
     * re-read all of them. */
    pendingScope: "settings",
    fetchToken: 0,
    rendering: { light: false },
    lastErrors: [],
    /* Campaigns already warned about unresolvable share links, so the
     * notice fires once per session rather than on every open. */
    shareWarnedCampaigns: new Set(),
    cache: {
      hasCache: false,
      savedAt: 0,
      fetchKey: "",
      cachedSubs: [],
      cachedCount: 0,
      lastRefreshAt: 0,
    },

    /* Dual-ended "I can post between X and Y" window, minutes of day.
     * null = all day. Constrains Timing recommendations without refitting. */
    postingAvail: null,

    /* When each subreddit was last read from the archive, keyed by
     * lowercase name: { at, count, error }. Without this the only
     * honest answer to "what needs fetching" is "all of it", which is
     * why the single Refresh button used to re-read a hundred and
     * seventy subs to pick up one new one. Persisted, because
     * staleness that resets on reload would send everyone straight
     * back to the full sweep. */
    subSync: {},
  };

  state.KEYS = KEYS;

  /* ---------- Persistence ---------- */

  state.load = function () {
    try {
      const subs = JSON.parse(localStorage.getItem(KEYS.subs) || "null");
      state.knownSubs = Array.isArray(subs) ? subs : [];
      const active = JSON.parse(localStorage.getItem(KEYS.active) || "null");
      state.activeSubs = new Set(Array.isArray(active) ? active : []);
      state.listing = localStorage.getItem(KEYS.listing) || "hot";
      state.timeWindow = localStorage.getItem(KEYS.time) || "week";
      state.limit = Number(localStorage.getItem(KEYS.limit)) || 100;
      const rawSpheres = localStorage.getItem(KEYS.spheres);
      if (rawSpheres) {
        const parsed = JSON.parse(rawSpheres);
        if (Array.isArray(parsed)) state.activeSpheres = parsed.filter((k) => typeof k === "string");
      }
      const rawSync = localStorage.getItem(KEYS.subSync);
      if (rawSync) {
        const parsed = JSON.parse(rawSync);
        if (parsed && typeof parsed === "object") state.subSync = parsed;
      }
      const rawAvail = localStorage.getItem(KEYS.postingAvail);
      if (rawAvail) {
        const parsed = JSON.parse(rawAvail);
        if (parsed && typeof parsed.start === "number" && typeof parsed.end === "number"
            && parsed.end > parsed.start && parsed.end - parsed.start < 1440) {
          state.postingAvail = { start: parsed.start, end: parsed.end };
        }
      }
    } catch (_) {
      state.knownSubs = [];
      state.activeSubs = new Set();
      state.subSync = {};
      state.postingAvail = null;
    }
  };

  state.persist = function () {
    try {
      localStorage.setItem(KEYS.subs, JSON.stringify(state.knownSubs));
      localStorage.setItem(KEYS.active, JSON.stringify(Array.from(state.activeSubs)));
      localStorage.setItem(KEYS.listing, state.listing);
      localStorage.setItem(KEYS.time, state.timeWindow);
      localStorage.setItem(KEYS.limit, String(state.limit));
    } catch (_) {
      /* Private browsing / storage disabled — the in-memory state still
       * works for the session, which is the honest degradation. */
    }
  };

  state.persistPostingAvail = function () {
    try {
      if (!state.postingAvail) localStorage.removeItem(KEYS.postingAvail);
      else localStorage.setItem(KEYS.postingAvail, JSON.stringify(state.postingAvail));
    } catch (_) {}
  };

  /* Set the dual-ended posting window (minutes of day). Pass null or
   * an all-day span to clear. Returns the normalised value stored. */
  state.setPostingAvail = function (startMin, endMin) {
    if (startMin == null && endMin == null) {
      state.postingAvail = null;
    } else if (window.Timing && Timing.normalizeAvailability) {
      state.postingAvail = Timing.normalizeAvailability(startMin, endMin);
    } else {
      state.postingAvail = { start: startMin, end: endMin };
    }
    state.persistPostingAvail();
    return state.postingAvail;
  };

  state.persistSpheres = function () {
    try {
      localStorage.setItem(KEYS.spheres, JSON.stringify(state.activeSpheres || []));
    } catch (_) {}
  };

  /* ---------- Sync ledger ---------- */

  state.persistSubSync = function () {
    try {
      localStorage.setItem(KEYS.subSync, JSON.stringify(state.subSync || {}));
    } catch (_) {}
  };

  /* Stamp one subreddit as just-read. `info.error` records a failed
   * attempt: the timestamp still moves, so a sub the archive keeps
   * refusing does not sit at the top of the stale list forever
   * re-requesting itself, but the error is kept so the row can say
   * why it has no posts. */
  state.markSynced = function (name, info) {
    const lc = String(name || "").toLowerCase();
    if (!lc) return;
    state.subSync[lc] = Object.assign({ at: Date.now() }, info || {});
  };

  /* Milliseconds since this sub was last read, or null if it never
   * has been — which callers treat as maximally stale rather than
   * as fresh. */
  state.syncAgeOf = function (name) {
    const rec = state.subSync[String(name || "").toLowerCase()];
    return rec && rec.at ? Math.max(0, Date.now() - rec.at) : null;
  };

  state.clearSubSync = function (names) {
    if (names == null) state.subSync = {};
    else {
      for (const n of [].concat(names)) delete state.subSync[String(n || "").toLowerCase()];
    }
    state.persistSubSync();
  };

  /* ---------- Subreddit scope helpers ---------- */

  /* Add one or many subreddits to the dashboard. Returns the list of
   * names that were genuinely new, so callers can report "added 6 of 9"
   * rather than claiming credit for duplicates. */
  state.addSubs = function (names, opts) {
    opts = opts || {};
    const added = [];
    /* Keyed by lowercase but holding the spelling already in
     * knownSubs. Re-adding a sub that is on the list under a different
     * casing used to put the normalised spelling into activeSubs
     * alongside the original, so the set outgrew the list it is
     * supposed to be a subset of and the chip — matched against the
     * knownSubs spelling — rendered as inactive right after the user
     * added it. */
    const known = new Map();
    for (const s of state.knownSubs) known.set(s.toLowerCase(), s);
    for (const raw of [].concat(names || [])) {
      const name = window.Util ? Util.normalizeSubName(raw) : String(raw || "").trim();
      if (!name) continue;
      const lc = name.toLowerCase();
      if (!known.has(lc)) {
        state.knownSubs.push(name);
        known.set(lc, name);
        added.push(name);
      }
      if (opts.activate !== false) state.activeSubs.add(known.get(lc));
    }
    if (added.length || opts.activate !== false) state.persist();
    return added;
  };

  state.removeSub = function (name) {
    return state.removeSubs([name]);
  };

  /* Drop many at once. Removing a forty-sub sphere one name at a time
   * meant forty passes over knownSubs and forty writes to localStorage;
   * this is one of each. Returns the names actually removed. */
  state.removeSubs = function (names) {
    const drop = new Set([].concat(names || [])
      .map((n) => String(n || "").toLowerCase())
      .filter(Boolean));
    if (!drop.size) return [];
    const removed = state.knownSubs.filter((s) => drop.has(s.toLowerCase()));
    if (!removed.length) return [];
    state.knownSubs = state.knownSubs.filter((s) => !drop.has(s.toLowerCase()));
    for (const s of Array.from(state.activeSubs)) {
      if (drop.has(s.toLowerCase())) state.activeSubs.delete(s);
    }
    /* An unloaded sub that is loaded again later is new data, not
     * data from whenever it was last here. */
    for (const lc of drop) delete state.subSync[lc];
    state.persistSubSync();
    state.persist();
    return removed;
  };

  /* Include or exclude many from the next fetch without unloading
   * them. Only ever touches subs already known, so a stale selection
   * cannot smuggle a name back in.
   *
   *   setActive(names, true|false)  flip those names on or off
   *   setActive(names)              replace the whole active set with
   *                                 exactly these names (used by the
   *                                 multi-select filter, which speaks
   *                                 in wholes rather than deltas) */
  state.setActive = function (names, on) {
    const want = new Set([].concat(names || [])
      .map((n) => String(n || "").toLowerCase())
      .filter(Boolean));
    let changed = 0;

    if (arguments.length < 2) {
      /* Replace. Empty selection is allowed — it means "show nothing",
       * which is what every chip being off already means. */
      const next = new Set();
      for (const s of state.knownSubs) {
        if (want.has(s.toLowerCase())) next.add(s);
      }
      if (next.size !== state.activeSubs.size
          || Array.from(next).some((s) => !state.activeSubs.has(s))) {
        state.activeSubs = next;
        changed = 1;
      }
    } else {
      if (!want.size) return 0;
      for (const s of state.knownSubs) {
        if (!want.has(s.toLowerCase())) continue;
        const has = state.activeSubs.has(s);
        if (on && !has) { state.activeSubs.add(s); changed++; }
        else if (!on && has) { state.activeSubs.delete(s); changed++; }
      }
    }
    if (changed) state.persist();
    return changed;
  };

  state.toggleSub = function (name) {
    const match = Array.from(state.activeSubs).find(
      (s) => s.toLowerCase() === String(name || "").toLowerCase()
    );
    if (match) state.activeSubs.delete(match);
    else state.activeSubs.add(name);
    state.persist();
    return !match;
  };

  state.hasSub = function (name) {
    const lc = String(name || "").toLowerCase();
    return state.knownSubs.some((s) => s.toLowerCase() === lc);
  };

  /* Posts for one subreddit out of the loaded pool. */
  state.postsForSub = function (name) {
    const lc = String(name || "").toLowerCase();
    return state.posts.filter((p) => (p.subreddit || "").toLowerCase() === lc);
  };

  window.AppState = state;
})();
