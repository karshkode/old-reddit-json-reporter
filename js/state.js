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

    /* ---- Dashboard chart controls ---- */
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
    targetingFor: { ai: null, campaigns: null },
    recommend: {
      targeting: {
        inline: { page: 0, pageSize: 25 },
        ai: { page: 0, pageSize: 25 },
        campaigns: { page: 0, pageSize: 25 },
      },
      discover: {
        new: { page: 0, pageSize: 25 },
        already: { page: 0, pageSize: 25 },
      },
    },
    lastRenderedTargeting: { inline: null, ai: null, campaigns: null },

    /* ---- Campaign workspace ---- */
    openCampaignId: null,
    campaignSection: "overview",
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
    fetchToken: 0,
    rendering: { light: false },
    lastTransport: null,
    lastErrors: [],
    cache: {
      hasCache: false,
      savedAt: 0,
      fetchKey: "",
      cachedSubs: [],
      cachedCount: 0,
      lastRefreshAt: 0,
    },
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
    } catch (_) {
      state.knownSubs = [];
      state.activeSubs = new Set();
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

  state.persistSpheres = function () {
    try {
      localStorage.setItem(KEYS.spheres, JSON.stringify(state.activeSpheres || []));
    } catch (_) {}
  };

  /* ---------- Subreddit scope helpers ---------- */

  /* Add one or many subreddits to the dashboard. Returns the list of
   * names that were genuinely new, so callers can report "added 6 of 9"
   * rather than claiming credit for duplicates. */
  state.addSubs = function (names, opts) {
    opts = opts || {};
    const added = [];
    const known = new Set(state.knownSubs.map((s) => s.toLowerCase()));
    for (const raw of [].concat(names || [])) {
      const name = window.Util ? Util.normalizeSubName(raw) : String(raw || "").trim();
      if (!name) continue;
      const lc = name.toLowerCase();
      if (!known.has(lc)) {
        state.knownSubs.push(name);
        known.add(lc);
        added.push(name);
      }
      if (opts.activate !== false) state.activeSubs.add(name);
    }
    if (added.length || opts.activate !== false) state.persist();
    return added;
  };

  state.removeSub = function (name) {
    const lc = String(name || "").toLowerCase();
    state.knownSubs = state.knownSubs.filter((s) => s.toLowerCase() !== lc);
    for (const s of Array.from(state.activeSubs)) {
      if (s.toLowerCase() === lc) state.activeSubs.delete(s);
    }
    state.persist();
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
