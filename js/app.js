/* =====================================================================
 * APP ORCHESTRATOR
 * ---------------------------------------------------------------------
 * Bootstraps the modules, owns the fetch lifecycle, and wires DOM events
 * to the analysis, chart and view layers. Application state lives in
 * js/state.js and view rendering lives in js/views/*.js — this file is
 * the wiring between them.
 * ===================================================================== */
(function () {
  /* Shared mutable state, defined in js/state.js. */
  const state = window.AppState;
  const STORAGE_KEYS = state.KEYS;

  /* `_runDiscover` is populated by bind() once the targeting panel has
   * been wired up, so other handlers (e.g. the post-row "Make campaign"
   * flow) can trigger discovery without faking a button click. */
  let _runDiscover = null;


  function isMobile() {
    return window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
  }

  /* ---------- Persistence ---------- */

  const loadPersisted = state.load;
  const persist = state.persist;

  /* Hydrate state.posts from the persistent post cache so a page
   * reload doesn't have to re-fetch from Reddit before the dashboard
   * is usable.
   *
   * - Cached posts whose subreddit is no longer in state.activeSubs
   *   are filtered out (they'd render but the user can't see why,
   *   since they're not in the chip set anymore). They stay in the
   *   on-disk cache for when the user re-adds the sub.
   * - The action banner is set to a "cached" phase showing the age
   *   of the cache and a Refresh button. The user must tap Refresh
   *   to fetch new data; we no longer auto-fetch on every reload.
   * - If the cache's fetchKey doesn't match the current settings
   *   (user changed listing/time/limit since last fetch), we still
   *   hydrate but mark pendingChanges so the action banner reads
   *   "Filters changed since cache — tap Go for fresh data".
   * - Returns true if cache hydration succeeded; the caller can
   *   skip the empty-state "Add subs and tap Go" banner in that case.
   */
  async function hydrateFromPostCache() {
    if (typeof PostCache === "undefined") return false;
    let cached;
    try { cached = await PostCache.load(); } catch (_) { cached = null; }
    if (!cached || !Array.isArray(cached.posts) || !cached.posts.length) return false;

    const activeArr = Array.from(state.activeSubs);
    const filtered = PostCache.filterByActiveSubs(cached.posts, activeArr);
    state.posts = filtered;
    state.cache.hasCache = true;
    state.cache.savedAt = Number(cached.savedAt) || 0;
    state.cache.fetchKey = String(cached.fetchKey || "");
    state.cache.cachedSubs = Array.isArray(cached.activeSubs) ? cached.activeSubs.slice() : [];
    state.cache.cachedCount = cached.posts.length;

    /* Detect filter mismatch — if the user changed settings since
     * the last save, we have stale data relative to their chosen
     * listing/time/limit. Hydrate it anyway (something is better
     * than nothing) but flag pendingChanges so the action banner
     * recommends a Refresh. */
    const currentKey = PostCache.buildFetchKey(activeArr, state.listing, state.timeWindow, state.limit);
    state.pendingChanges = (currentKey !== state.cache.fetchKey);

    console.log(`[postcache] hydrated ${filtered.length} posts (${cached.posts.length} cached, age=${PostCache.formatAge(cached.savedAt)})${state.pendingChanges ? " — filters changed since cache" : ""}`);
    return true;
  }

  /* Drive the action banner into a "cached/loaded" phase that
   * shows the cache age + a Refresh CTA. Called once after
   * hydrateFromPostCache returns true. */
  function showCachedActionBanner() {
    if (typeof Util === "undefined" || !Util.setActionPhase) return;
    const ageStr = (typeof PostCache !== "undefined" && state.cache.savedAt)
      ? PostCache.formatAge(state.cache.savedAt)
      : "";
    const head = state.pendingChanges
      ? "Filters changed since cache"
      : `Showing cached data from ${ageStr}`;
    const tail = state.pendingChanges
      ? "Tap Go for fresh data."
      : `${state.posts.length} posts loaded · tap Refresh to fetch new posts.`;
    /* The action button reads "Go" in pending phase and "Refresh"
     * in loaded — picked here based on whether the user has
     * unfetched changes since the last cached refresh. */
    Util.setActionPhase(state.pendingChanges ? "pending" : "loaded", `${head}. ${tail}`);
  }

  /* Persist current state.posts to the post cache. Fire-and-forget;
   * failures are logged but don't break the render pipeline. */
  async function persistPostCache() {
    if (typeof PostCache === "undefined") return;
    if (!state.posts.length) return;  /* don't overwrite a good cache with empty */
    try {
      await PostCache.save(state.posts, {
        fetchKey: PostCache.buildFetchKey(
          Array.from(state.activeSubs),
          state.listing,
          state.timeWindow,
          state.limit
        ),
        activeSubs: Array.from(state.activeSubs),
      });
      state.cache.hasCache = true;
      state.cache.savedAt = Date.now();
      state.cache.cachedSubs = Array.from(state.activeSubs);
      state.cache.cachedCount = state.posts.length;
    } catch (e) {
      console.warn("[postcache] persist failed:", e && e.message);
    }
  }

  /* ---------- Banner ---------- */

  function showBanner(kind, html) {
    const main = document.querySelector("main");
    if (!main) return;
    let banner = document.getElementById("banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "banner";
      main.insertBefore(banner, main.firstChild);
    }
    banner.className = "banner " + (kind || "info");
    banner.innerHTML = html;
  }
  function hideBanner() {
    const banner = document.getElementById("banner");
    if (banner) banner.remove();
  }

  /* ---------- Settings sheet ---------- */

  /* Fetch settings, data source and cache controls used to live in a
   * collapsible drawer wedged between the topbar and the content, which
   * pushed the actual data down the page on every open. They are now a
   * dialog that overlays instead. */
  function setSettingsOpen(open) {
    const sheet = document.getElementById("settings-sheet");
    const backdrop = document.getElementById("settings-sheet-backdrop");
    if (!sheet) return;
    sheet.hidden = !open;
    if (backdrop) backdrop.hidden = !open;
    document.body.classList.toggle("sheet-open", open);
    if (open) {
      const first = sheet.querySelector("select, input, button");
      if (first) first.focus();
    }
  }

  function settingsAreOpen() {
    const sheet = document.getElementById("settings-sheet");
    return !!(sheet && !sheet.hidden);
  }

  /* ---------- Filtering ---------- */

  function filteredPosts() {
    let list = state.posts;
    if (state.postIdFilter.length) {
      const set = new Set(state.postIdFilter.map((id) => id.toLowerCase()));
      list = list.filter((p) => set.has(p.id.toLowerCase()));
    }
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      list = list.filter((p) =>
        (p.title || "").toLowerCase().includes(q) ||
        (p.author || "").toLowerCase().includes(q) ||
        (p.flair || "").toLowerCase().includes(q)
      );
    }
    if (state.postsSubFilter) {
      const sub = state.postsSubFilter.toLowerCase();
      list = list.filter((p) => (p.subreddit || "").toLowerCase() === sub);
    }
    /* Score-range chip filter (constraint, distinct from free-text
     * search). state.postsScoreMin is a numeric threshold; 0 means no
     * filter. Chips on the Posts tab toggle this. */
    if (state.postsScoreMin && state.postsScoreMin > 0) {
      const min = state.postsScoreMin;
      list = list.filter((p) => (p.score || 0) >= min);
    }
    list = list.slice().sort((a, b) => {
      const k = state.sortKey;
      const va = a[k]; const vb = b[k];
      let cmp;
      if (typeof va === "number" || typeof vb === "number") cmp = (va || 0) - (vb || 0);
      else cmp = String(va || "").localeCompare(String(vb || ""));
      return state.sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }

  /* Cross-post groups filtering pipeline. Mirrors filteredPosts() —
   * applies sub filter, free-text search, and min-spread chips in
   * sequence. The original sort order from Analysis.detectCrossPosts
   * (spread DESC, then totalScore DESC) is preserved. */
  function filteredCrossPosts() {
    let list = state.crossPosts || [];
    if (state.crossPostsSubFilter) {
      const sub = state.crossPostsSubFilter.toLowerCase();
      list = list.filter((g) => g.subs.includes(sub));
    }
    if (state.crossPostsSearchQuery) {
      const q = state.crossPostsSearchQuery.toLowerCase();
      list = list.filter((g) => {
        if (g.kind === "url" && g.key && g.key.toLowerCase().includes(q)) return true;
        return (g.posts || []).some((p) => (p.title || "").toLowerCase().includes(q));
      });
    }
    if (state.crossPostsMinSpread && state.crossPostsMinSpread > 0) {
      const min = state.crossPostsMinSpread;
      list = list.filter((g) => (g.subs || []).length >= min);
    }
    return list;
  }

  /* Render the cross-posts list + its pagination + the result-count
   * meta line. Called from rerenderAll() and from the search/filter/
   * chip event handlers so the view updates without a full data
   * refetch. */
  function renderCrossPostsView() {
    const xpFiltered = filteredCrossPosts();
    UI.renderCrossPosts(xpFiltered, {
      page: state.crossPostsPage,
      pageSize: state.crossPostsPageSize === "all" ? "all" : Number(state.crossPostsPageSize),
    });
    UI.renderPagination("crossposts-pagination", {
      page: state.crossPostsPage,
      totalItems: xpFiltered.length,
      pageSize: state.crossPostsPageSize === "all" ? "all" : Number(state.crossPostsPageSize),
      onChange: (newPage) => { state.crossPostsPage = newPage; renderCrossPostsView(); },
    });
    /* Update the live result-count line. Hidden when no filter is
     * active so the empty state stays clean. */
    const meta = document.getElementById("crossposts-meta");
    if (meta) {
      const total = (state.crossPosts || []).length;
      const filterActive = !!(state.crossPostsSubFilter || state.crossPostsSearchQuery || state.crossPostsMinSpread);
      if (!filterActive || !total) {
        meta.hidden = true;
        meta.textContent = "";
      } else {
        meta.hidden = false;
        meta.textContent = xpFiltered.length === total
          ? `${total} cross-post group${total === 1 ? "" : "s"}`
          : `${xpFiltered.length} of ${total} cross-post group${total === 1 ? "" : "s"} match`;
      }
    }
  }

  /* ---------- Render pipeline ---------- */

  /* One-stop render of the Posts table + its pagination strip. Both
   * rerenderLight and rerenderAll funnel through this so pagination is
   * honoured on every update — the previous code only passed page/
   * pageSize opts in rerenderAll, so any rerenderLight (per-page
   * streaming during refresh, dropdown change, sort flip, etc.)
   * silently re-rendered the entire list regardless of "Per page". */
  function renderPostsView() {
    const posts = filteredPosts();
    const pageSize = state.postsPageSize === "all" ? "all" : Number(state.postsPageSize) || 25;
    /* Clamp page index in case filters shrank the list below the
     * current page. UI.renderPagination already clamps for display,
     * but we keep state.postsPage honest so the next user click is
     * from a valid base. */
    if (pageSize !== "all") {
      const totalPages = Math.max(1, Math.ceil(posts.length / pageSize));
      if (state.postsPage > totalPages - 1) state.postsPage = totalPages - 1;
      if (state.postsPage < 0) state.postsPage = 0;
    }
    UI.renderPostsTable(posts, state.sortKey, state.sortDir, openPostDetail, {
      page: state.postsPage,
      pageSize,
    });
    UI.renderPagination("posts-pagination", {
      page: state.postsPage,
      totalItems: posts.length,
      pageSize,
      onChange: (newPage) => { state.postsPage = newPage; renderPostsView(); },
    });
    return posts;
  }

  /* Lightweight render: KPIs + posts table only. Used during in-progress
   * batch fetches so the user sees data accumulate without paying the
   * per-update cost of redrawing 8 Chart.js canvases and recomputing
   * every theme/profile. */
  function rerenderLight() {
    const posts = filteredPosts();
    const agg = Analysis.aggregate(posts);
    UI.renderKpis(agg, Analysis.postingTimes(posts));
    renderPostsView();
  }

  /* Full re-render after the dataset changed.
   *
   * This computes the derivations that more than one view needs, then
   * hands off to the router, which renders the visible view now and
   * marks the rest dirty. The previous build re-rendered every pane
   * unconditionally, so a refresh redrew eight off-screen Chart.js
   * canvases plus the themes and profile lists nobody was looking at. */
  function rerenderAll() {
    if (state.rendering.light) return rerenderLight();

    const posts = filteredPosts();

    state.subProfiles = Analysis.subredditProfiles(posts);
    /* Attach an engagement-trend slope per sub so recommendTargets can
     * fold "trending up / down / flat" into its composite score. */
    if (Object.keys(state.subProfiles).length) {
      const bySub = {};
      for (const p of posts) {
        const k = (p.subreddit || "").toLowerCase();
        if (!k) continue;
        (bySub[k] = bySub[k] || []).push(p);
      }
      for (const [k, list] of Object.entries(bySub)) {
        if (state.subProfiles[k]) state.subProfiles[k]._trend = Analysis.engagementTrend(list);
      }
    }

    const crossPosts = Analysis.detectCrossPosts(posts);
    /* Tag each group with its absolute index so render-after-filter/page
     * still resolves back to state.crossPosts[idx] from the click handler. */
    crossPosts.forEach((g, i) => { g._origIndex = i; });
    state.crossPosts = crossPosts;

    refreshSubFilterDropdowns();
    populateCampaignSelectors();
    updateRailCounts();
    Router.invalidate(["dashboard", "posts", "campaigns", "campaign", "communities"]);
  }

  /* Live counts beside each nav destination, so the rail doubles as a
   * status readout. */
  function updateRailCounts() {
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.hidden = !value;
      el.textContent = value > 999 ? Math.round(value / 1000) + "k" : String(value);
    };
    set("rail-count-campaigns", Campaigns.list().length);
    set("rail-count-subs", state.knownSubs.length);
    set("rail-count-posts", state.posts.length);
  }

  /* ---------- Action banner (manual-trigger gating) ---------- */

  /* Build the standard "N subs queued · hot · week · limit X" tail
   * shown in the action banner whenever the dataset is stale or just
   * loaded — gives the user immediate context for what the next fetch
   * (or the last fetch) will / did cover. */
  function describePendingFetch() {
    const subCount = state.activeSubs ? state.activeSubs.size : 0;
    if (!subCount) return "Add at least one subreddit, then tap Go.";
    return `${subCount} subreddit${subCount === 1 ? "" : "s"} queued · ${state.listing} · ${state.timeWindow} · limit ${state.limit}`;
  }

  /* Mark the dataset stale and flip the action banner into the
   * "pending" phase so the button reads Go ▶ and the user can trigger
   * the fetch when they're ready. Called whenever filters, sub list,
   * listing, time window, or limit change — anything that would have
   * previously auto-fired refreshData(). */
  function markPending(reason) {
    state.pendingChanges = true;
    /* Don't override the loading phase mid-fetch; pendingChanges will
     * be re-checked when the fetch completes. */
    const banner = document.getElementById("action-banner");
    if (banner && banner.classList.contains("phase-loading")) return;
    const tail = describePendingFetch();
    Util.setActionPhase("pending", reason ? `${reason} — ${tail}` : tail);
  }

  /* "Deploy a Cloudflare Worker" suggestion banner.
   *
   * Visibility rules:
   *   - Hidden if the user already pasted a custom proxy URL (they're
   *     already on the recommended path).
   *   - Hidden if the user has manually dismissed it this session.
   *   - Shown when public-proxy stats meet *both*:
   *       a. ≥3 attempts have been observed across the public proxies, AND
   *       b. NONE of the public proxies have a recent-window success rate
   *          ≥ 50%.
   *   This avoids false positives on first-load (no stats yet) and
   *   on transient single-proxy failures. */
  let proxyDownBannerDismissed = false;
  function maybeShowProxyDownBanner(statsByTransport) {
    const el = document.getElementById("proxy-down-banner");
    if (!el) return;
    if (proxyDownBannerDismissed) { el.hidden = true; return; }
    if (Reddit.getCustomProxyUrl && Reddit.getCustomProxyUrl()) { el.hidden = true; return; }

    const PUBLIC = ["codetabs", "allorigins", "corsproxy", "isomorphic"];
    let totalAttempts = 0;
    let anyHealthy = false;
    for (const name of PUBLIC) {
      const s = (statsByTransport || {})[name];
      if (!s) continue;
      const recent = (s.recent || []).slice(-20);
      const total = recent.length || (s.ok + s.fail);
      if (!total) continue;
      const ok = recent.length ? recent.filter((x) => x).length : s.ok;
      const rate = total ? ok / total : 1;
      totalAttempts += total;
      if (rate >= 0.5) anyHealthy = true;
    }

    el.hidden = !(totalAttempts >= 3 && !anyHealthy);
  }
  /* Wire the dismiss button — moved here so it's defined before
   * bind() runs. The button itself is set up in bind(). */
  function dismissProxyDownBanner() {
    proxyDownBannerDismissed = true;
    const el = document.getElementById("proxy-down-banner");
    if (el) el.hidden = true;
  }

  /* ---------- Data fetch ---------- */

  /* @param force  truthy means the user explicitly tapped Refresh and
   *               wants fresh data. The string "full" means a full
   *               reset — wipe both Reddit's request cache AND the
   *               persistent post cache before fetching, ignoring
   *               any merge with the previously cached pool. Plain
   *               truthy (true / 1 etc.) does a "soft" refresh:
   *               clear Reddit's request cache so we hit network,
   *               but PRESERVE the persistent post cache so we can
   *               merge fall-off-hot posts back into the new
   *               results.                                       */
  async function refreshData(force) {
    if (!state.activeSubs.size) {
      state.posts = [];
      Util.setStatus("No active subreddits selected.", "err");
      hideBanner();
      /* No subs to fetch but the user might still want to add some —
       * leave the action banner in pending mode so the Go button
       * stays visible once they do. */
      Util.setActionPhase("pending", "Add at least one subreddit, then tap Go.");
      rerenderAll();
      return;
    }
    if (force) Reddit.clearCache();

    /* "Full reset" wipes the persistent post cache too so the merge
     * step below has nothing to merge against — equivalent to first-
     * time fetch behavior. Soft refresh (force === true) keeps the
     * cache so fall-off-hot posts are preserved across reloads. */
    const fullReset = force === "full";
    let cachedPool = [];
    if (fullReset) {
      if (typeof PostCache !== "undefined") {
        try { await PostCache.clear(); } catch (_) {}
      }
      state.cache.hasCache = false;
      state.cache.savedAt = 0;
      state.cache.cachedCount = 0;
    } else if (typeof PostCache !== "undefined") {
      /* Stash the existing cached pool so we can merge it back in
       * after the fresh fetch completes. We re-load from disk
       * (rather than reusing state.posts) so we get cached posts
       * from subs that aren't currently displayed but should be
       * preserved through the merge. */
      try {
        const existing = await PostCache.load();
        cachedPool = (existing && Array.isArray(existing.posts)) ? existing.posts : [];
      } catch (_) {}
    }

    /* The action banner now switches to "loading" via the first
     * Util.setProgress() call below. No separate hide step needed. */

    const subs = Array.from(state.activeSubs);
    const myToken = ++state.fetchToken;
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    console.log(`[refreshData] start: ${subs.length} subs, listing=${state.listing}, limit=${state.limit}`);

    state.lastErrors = [];
    state.posts = [];
    state.rendering.light = true;
    /* Expected post count = subs * per-sub limit. Used as the progress
     * bar denominator so the bar fills smoothly as posts stream in
     * rather than jumping in N step-increments when each sub completes.
     * Some subs return fewer than the limit (small sub or short window)
     * so we cap visible progress at 95% during the loop and let
     * hideProgress() fill the remaining 5% when everything is done. */
    const expectedTotal = Math.max(50, subs.length * (state.limit || 100));
    function postProgressPct() {
      return Math.min(95, (state.posts.length / expectedTotal) * 100);
    }
    Util.setStatus(`Fetching ${subs.length} subreddit${subs.length > 1 ? "s" : ""}… 0/${subs.length}`, "", "via " + describeTransport());
    Util.setProgress(0, `Fetching ${subs.length} subreddit${subs.length > 1 ? "s" : ""}…  0 posts so far`);
    rerenderLight();

    /* Up to 3 subreddits in flight at once. More than that and the public
     * proxies start 429-ing. Each completion triggers a light re-render so
     * the user sees posts accumulate live instead of staring at a spinner. */
    const collected = [];
    let completed = 0;
    let errors = 0;
    /* Don't spam 20 individual error toasts when the same root cause
     * (all proxies down) is hitting every sub. Show the first one
     * normally; mute the rest, then surface ONE summary banner at
     * the end. The fetchJson circuit breaker already makes the
     * subsequent calls fast-fail in <1ms so the user isn't sitting
     * through 20 timeouts. */
    let circuitToastShown = false;

    await Util.pmap(subs, 3, async (sub) => {
      const subStart = (typeof performance !== "undefined" ? performance.now() : Date.now());
      let usedOnPage = false;
      try {
        const list = await Reddit.fetchSubredditListing(sub, {
          listing: state.listing,
          t: state.timeWindow,
          limit: state.limit,
          /* Stream each page of posts as it arrives. The progress bar
           * tracks total posts, not just the sub completion count, so
           * a fetch returning 100 posts in two pages bumps the bar
           * twice (~0.5% each at default limit) instead of waiting for
           * the whole sub to finish. */
          onPage: (newPosts) => {
            usedOnPage = true;
            if (state.fetchToken !== myToken) return;
            for (const p of newPosts) collected.push(p);
            state.posts = Util.uniqBy(collected, (p) => p.id);
            Util.setProgress(
              postProgressPct(),
              `Streaming r/${sub} · ${state.posts.length} post${state.posts.length === 1 ? "" : "s"} loaded · ${completed} / ${subs.length} sub${subs.length === 1 ? "" : "s"} done`
            );
            rerenderLight();
          },
        });
        if (state.fetchToken !== myToken) return;
        if (!usedOnPage) {
          /* Fallback if onPage didn't fire — e.g., the listing was
           * served from cache. Push synchronously so we don't lose data. */
          for (const p of list) collected.push(p);
          state.posts = Util.uniqBy(collected, (p) => p.id);
        }
        const dur = Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - subStart));
        console.log(`[refreshData] r/${sub}: ${list.length} posts in ${dur}ms`);
      } catch (err) {
        errors++;
        state.lastErrors.push({ sub, message: err.message });
        console.warn(`[refreshData] r/${sub} FAILED:`, err.message);
        /* Only show the first failure as a toast. After the circuit
         * breaker trips (.circuit === true) every subsequent call
         * fails in ~0ms; surface ONE summary toast about the proxies,
         * skip the rest so the user isn't carpet-bombed with the same
         * message 20 times. */
        if (err && err.circuit) {
          if (!circuitToastShown) {
            Util.toast("All public CORS proxies are failing right now. Skipping remaining subs — try Refresh in a minute.", "error");
            circuitToastShown = true;
          }
        } else {
          Util.toast(`r/${sub}: ${err.message}`, "error");
        }
      } finally {
        completed++;
        if (state.fetchToken === myToken) {
          /* Re-dedupe in case onPage hadn't fired for cached responses. */
          state.posts = Util.uniqBy(collected, (p) => p.id);
          Util.setStatus(
            `Fetching ${subs.length} subreddit${subs.length > 1 ? "s" : ""}… ${completed}/${subs.length}`,
            errors ? "err" : "",
            "via " + describeTransport()
          );
          Util.setProgress(
            postProgressPct(),
            `Loaded r/${sub} · ${completed} / ${subs.length} sub${subs.length === 1 ? "" : "s"} done · ${state.posts.length} posts so far`
          );
          rerenderLight();
        }
      }
    });

    if (state.fetchToken !== myToken) {
      console.log(`[refreshData] aborted (newer token outpaced this run)`);
      return;
    }

    const freshUnique = Util.uniqBy(collected, (p) => p.id);
    /* Merge the fresh fetch with the previously-cached pool (if any)
     * so a Refresh keeps showing posts that fell off the user's
     * current listing without re-fetching the whole tail. The merge
     * helper:
     *   - Prefers fresh copies on conflict (newer score / comments)
     *   - Drops cached posts > 14 days old
     *   - Drops cached posts whose subreddit is no longer active
     *
     * "Full reset" callers reach this branch with cachedPool = []
     * so it's a no-op merge. */
    let mergeSummary = null;
    if (cachedPool.length) {
      const merged = PostCache.merge(cachedPool, freshUnique, {
        activeSubs: Array.from(state.activeSubs),
      });
      state.posts = merged.posts;
      mergeSummary = merged;
      console.log(`[postcache] merged ${merged.totalFresh} fresh + ${merged.kept} kept from cache (${merged.replaced} replaced, ${merged.droppedAge} aged out, ${merged.droppedSub} now-inactive sub)`);
    } else {
      state.posts = freshUnique;
    }
    state.lastTransport = Reddit._lastTransport || state.lastTransport;
    state.rendering.light = false;
    /* Fetch finished — the dataset now matches the user's settings, so
     * pendingChanges is cleared. Util.hideProgress transitions the
     * action banner from "loading" -> "loaded" (button becomes
     * Refresh ↻, fill bar fades, text shows the load summary). */
    state.pendingChanges = false;
    state.cache.lastRefreshAt = Date.now();
    const newCount = mergeSummary ? freshUnique.length - mergeSummary.replaced : state.posts.length;
    const tail = ` · ${state.listing} · ${state.timeWindow} · limit ${state.limit}`;
    const loadedLine = mergeSummary
      ? `Refreshed: ${freshUnique.length} fetched (+${newCount} new) · ${state.posts.length} total in view${errors ? ` (${errors} error${errors > 1 ? "s" : ""})` : ""}${tail}`
      : `Loaded ${state.posts.length} posts from ${subs.length} sub${subs.length > 1 ? "s" : ""}${errors ? ` (${errors} error${errors > 1 ? "s" : ""})` : ""}${tail}`;
    Util.hideProgress(loadedLine);

    /* Persist to disk for the NEXT page reload. Fire-and-forget. */
    persistPostCache().catch(() => {});

    const totalMs = Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0));
    console.log(`[refreshData] complete: ${state.posts.length} unique posts in ${totalMs}ms (errors=${errors})`);

    Util.setStatus(
      `Loaded ${state.posts.length} posts from ${subs.length} sub${subs.length > 1 ? "s" : ""} in ${(totalMs / 1000).toFixed(1)}s` +
      (errors ? ` · ${errors} err` : ""),
      errors ? "err" : "ok",
      "via " + describeTransport()
    );

    if (state.posts.length === 0 && state.activeSubs.size > 0) {
      const errLines = state.lastErrors.map((e) => `<li><code>r/${Util.escapeHtml(e.sub)}</code> — ${Util.escapeHtml(e.message)}</li>`).join("");
      showBanner("bad", `
        <strong>All Reddit fetches failed.</strong>
        Reddit doesn't send CORS headers for browser requests, so this site routes through public CORS proxies. The currently selected proxy may be down or rate-limited.
        <ul style="margin:6px 0 0 18px;padding:0">${errLines}</ul>
        <span class="hint">Try picking a different <strong>Data source</strong> (top bar on desktop, in Filters on mobile), or wait a minute and tap <strong>Refresh</strong>.</span>
      `);
    } else if (state.posts.length > 0) {
      hideBanner();
    }

    rerenderAll();
    /* The local-first campaign aggregator can resolve campaign IDs from
     * the just-fetched subreddit posts without any extra network calls.
     * For IDs that aren't covered, give the proxy a brief breather (1.2s)
     * before kicking off the network pass — back-to-back bursts are what
     * trip codetabs's rate limiter. */
    setTimeout(() => {
      refreshAllCampaignSummaries().catch((err) => {
        console.warn("[refreshData] campaign refresh failed:", err && err.message);
      });
    }, 1200);
  }

  function describeTransport() {
    const pref = Reddit.getTransport();
    if (pref === "auto") return "auto" + (state.lastTransport ? " → " + state.lastTransport : "");
    return pref;
  }

  /* ---------- Post detail ---------- */

  async function openPostDetail(post) {
    Router.go("posts");
    const card = document.getElementById("post-detail");
    const body = document.getElementById("post-detail-body");
    card.hidden = false;
    body.innerHTML = `<div class="empty"><div class="skeleton" style="margin-bottom:6px"></div><div class="skeleton" style="margin-bottom:6px;width:80%"></div><div class="skeleton" style="width:60%"></div></div>`;
    try {
      let data = state.detailCache.get(post.id);
      if (!data && window.Demo && Demo.isActive()) {
        data = Demo.detailFor(post);
        if (data) state.detailCache.set(post.id, data);
      }
      if (!data) {
        data = await Reddit.fetchPostWithComments(post.id, { commentLimit: 50 });
        if (data) state.detailCache.set(post.id, data);
      }
      if (!data) throw new Error("post not found");
      UI.renderPostDetail(data.post, data.comments);
      renderRelatedForDetail(data.post);
    } catch (err) {
      body.innerHTML = `<div class="empty">Failed to load post: ${Util.escapeHtml(err.message)}</div>`;
    }
  }

  /* ---------- One post → spheres → related communities ---------- */

  /* Cached because a match costs a few dozen about.json reads and the
   * user will flip between posts. */
  function relatedForPost(post, opts) {
    const cached = state.postRelated.get(post.id);
    if (cached && !(opts && opts.force)) return Promise.resolve(cached);
    /* Loaded subs stay in the list rather than being excluded — "you
     * are already in the three rooms that matter" is an answer too. */
    return Discovery.forPost(post, {
      limit: 12,
      onPartial: opts && opts.onPartial,
      /* Demo mode is offline by contract. */
      live: !(window.Demo && Demo.isActive()),
    }).then((result) => {
      state.postRelated.set(post.id, result);
      return result;
    });
  }

  function renderRelatedForDetail(post) {
    const host = document.getElementById("post-related-body");
    if (!host) return;
    host.dataset.postId = post.id;

    function paint(result) {
      /* The panel is rebuilt on every post, so a slow match arriving
       * after the user moved on must not overwrite the new one. */
      if (!host.isConnected || host.dataset.postId !== post.id) return;
      UI.renderPostRelated(host, result);
    }

    UI.renderPostRelated(host, null);
    relatedForPost(post, { onPartial: paint })
      .then(paint)
      .catch((err) => {
        if (!host.isConnected || host.dataset.postId !== post.id) return;
        host.innerHTML = `<p class="post-related-status">Couldn't match communities: ${Util.escapeHtml(err.message || String(err))}</p>`;
      });
  }

  /* Every checked community inside a related panel. */
  function checkedRelatedSubs(scope) {
    const root = scope || document;
    return Array.from(root.querySelectorAll("input[data-related-sub]:checked:not(:disabled)"))
      .map((el) => el.dataset.relatedSub)
      .filter(Boolean);
  }

  /* ---------- Campaigns ---------- */

  async function refreshAllCampaignSummaries() {
    const list = Campaigns.list();
    if (!list.length) {
      state.campaignSummaries = {};
      Router.invalidate(["campaigns"]);
      populateCampaignSelectors();
      return;
    }
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const summaries = {};

    /* First pass: instant render using only the dashboard's already-loaded
     * subreddit posts. No network. Lets the user see partial totals
     * immediately even when the proxy is slow. */
    for (const c of list) {
      try {
        summaries[c.id] = await Campaigns.fetchAggregated(c, { fromPosts: state.posts, skipNetwork: true });
      } catch (_) {
        summaries[c.id] = { totalScore: 0, totalComments: 0, posts: [], subs: [], missing: c.postIds };
      }
    }
    state.campaignSummaries = summaries;
    Router.invalidate(["campaigns"]);
    populateCampaignSelectors();

    /* Second pass: fill in the rest from the network. Concurrency 2 keeps
     * the proxy from being overwhelmed while the subreddit batch may have
     * just finished. Local-first means most IDs already resolve here so
     * this often does zero or one network calls per campaign. */
    await Util.pmap(list, 2, async (c) => {
      try {
        const agg = await Campaigns.fetchAggregated(c, { fromPosts: state.posts });
        summaries[c.id] = agg;
      } catch (err) {
        console.warn(`[campaigns] ${c.name} fetch failed:`, err && err.message);
        /* Keep the local-only result we already rendered above. */
      }
    });
    state.campaignSummaries = summaries;
    Router.invalidate(["campaigns"]);
    populateCampaignSelectors();
    updateRailCounts();

    const dur = Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0));
    console.log(`[campaigns] refreshed ${list.length} in ${dur}ms`);
  }

  /* Load one campaign's data and hand it to the workspace view.
   *
   * Two passes: an instant local one from posts already in memory, then
   * a network pass for anything unresolved. Both write into state and
   * invalidate the campaign route rather than painting DOM directly, so
   * the view owns its own markup.
   */
  async function loadCampaign(idOrCampaign) {
    let campaign = typeof idOrCampaign === "string" ? Campaigns.get(idOrCampaign) : idOrCampaign;
    if (!campaign) return;

    state.openCampaignId = campaign.id;
    refreshWatchToggleUI(state.watchedCampaignId === campaign.id && !!watchTimer);

    /* Auto-repair: campaigns saved by older builds could hold raw mobile
     * share URLs in postIds. Resolve them once and rewrite the record so
     * future opens take the fast path. */
    const shareEntries = (campaign.postIds || []).filter((s) => Util.isShareUrl(s));
    if (shareEntries.length) {
      try {
        Util.setStatus(`Resolving ${shareEntries.length} share URL${shareEntries.length === 1 ? "" : "s"}…`, "");
        const { resolved, failed } = await Reddit.resolveShareUrls(shareEntries);
        const newPostIds = [];
        const seen = new Set();
        let fixed = 0;
        for (const old of campaign.postIds) {
          const resolvedId = Util.isShareUrl(old) ? resolved[old] : old;
          if (resolvedId && !seen.has(resolvedId)) {
            seen.add(resolvedId);
            newPostIds.push(resolvedId);
            if (Util.isShareUrl(old)) fixed++;
          } else if (!resolvedId && Util.isShareUrl(old)) {
            /* Keep the original so the user can see what failed. */
            newPostIds.push(old);
          }
        }
        Campaigns.update(campaign.id, { postIds: newPostIds });
        campaign = Campaigns.get(campaign.id);
        if (failed.length) {
          Util.toast(`Repaired ${fixed} of ${shareEntries.length} share URLs (${failed.length} failed).`, "error");
        } else if (fixed) {
          Util.toast(`Repaired ${fixed} share URL${fixed === 1 ? "" : "s"}.`, "ok");
        }
      } catch (err) {
        console.warn("[campaign] share-URL repair failed:", err && err.message);
      }
    }

    function publish(agg) {
      agg.campaignId = campaign.id;
      state.campaignAgg = agg;
      state.campaignSummaries[campaign.id] = agg;
      state.campaignDeep = computeCampaignDeep(campaign, agg);
      Router.invalidate(["campaign", "campaigns"]);
      updateRailCounts();
    }

    let localAgg = null;
    try {
      localAgg = await Campaigns.fetchAggregated(campaign, { fromPosts: state.posts, skipNetwork: true });
      publish(localAgg);
    } catch (_) {
      /* The view is already showing skeletons. */
    }

    /* Bounded so a hanging proxy cannot leave the user staring at a
     * skeleton forever; the local render stays put if it fires. */
    try {
      const agg = await Promise.race([
        Campaigns.fetchAggregated(campaign, { fromPosts: state.posts }),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error("Network refresh timed out — proxies may be down. Tap Refresh to retry.")),
          20000
        )),
      ]);
      publish(agg);
      console.log(`[campaign] ${campaign.name}: local=${agg.resolvedFromLocal} network=${agg.resolvedFromNetwork} missing=${agg.missing.length}`);
    } catch (err) {
      const msg = (err && err.message) || String(err);
      console.warn(`[campaign] ${campaign.name} network refresh failed:`, msg);
      if (localAgg && localAgg.posts.length) {
        Util.toast(`Couldn't refresh "${campaign.name}" from Reddit. Showing locally-resolved posts.`, "error");
      } else {
        const agg = localAgg || { posts: [], subs: [], missing: campaign.postIds || [], totalScore: 0, totalComments: 0 };
        agg.networkError = msg;
        publish(agg);
      }
    }
  }

  /* Kept as the entry point used by list rows and the post-row
   * "Make campaign" flow: navigate, and let the route load the data. */
  function openCampaign(campaign) {
    const id = typeof campaign === "string" ? campaign : (campaign && campaign.id);
    if (!id) return;
    Router.go("campaign", { id: id });
  }

  /* ---------- Deep analysis for a campaign ---------- */

  function computeCampaignDeep(campaign, agg) {
    if (!agg || !agg.posts || !agg.posts.length) {
      return {
        profile: Analysis.profile([], { label: campaign.name }),
        perSub: [],
        comparison: null,
        targets: [],
        narrative: "<p>No resolved posts yet — nothing to analyze.</p>",
      };
    }
    const profile = Analysis.campaignProfile(agg.posts, campaign);

    /* per-subreddit performance for this campaign */
    const perSub = {};
    for (const p of agg.posts) {
      const s = (p.subreddit || "").toLowerCase();
      if (!s) continue;
      if (!perSub[s]) perSub[s] = { subreddit: s, count: 0, totalScore: 0, totalComments: 0, ratios: [] };
      perSub[s].count++;
      perSub[s].totalScore += p.score || 0;
      perSub[s].totalComments += p.num_comments || 0;
      if (p.upvote_ratio != null) perSub[s].ratios.push(p.upvote_ratio);
    }
    const perSubArr = Object.values(perSub).map((r) => ({
      ...r,
      avgScore: r.totalScore / r.count,
      avgComments: r.totalComments / r.count,
      avgUpvoteRatio: r.ratios.length ? r.ratios.reduce((a, b) => a + b, 0) / r.ratios.length : null,
    })).sort((a, b) => b.totalScore - a.totalScore);

    const comparison = Analysis.compareTopBottom(agg.posts);
    /* Was 8. Now full ranked tail so the inline targeting card in
     * the campaign detail can paginate through the entire ranked
     * list of loaded subs, not just the top handful. */
    const targets = Analysis.recommendTargets(profile, state.subProfiles, { limit: 200 });
    const narrative = buildCampaignNarrative(campaign, profile, perSubArr, comparison);

    return { profile, perSub: perSubArr, comparison, targets, narrative };
  }

  function buildCampaignNarrative(campaign, profile, perSub, comparison) {
    const parts = [];
    const sentLean = profile.sentiment.average > 0.1
      ? "<strong>positive-leaning</strong>"
      : profile.sentiment.average < -0.1
      ? "<strong>negative-leaning</strong>"
      : "<strong>balanced</strong>";

    parts.push(`<p>The <strong>${Util.escapeHtml(campaign.name)}</strong> campaign currently has <strong>${profile.count}</strong> resolved posts across <strong>${profile.subreddits.length}</strong> subreddit${profile.subreddits.length > 1 ? "s" : ""}, totalling <strong>${Util.fmtNum(profile.totalScore)}</strong> upvotes and <strong>${Util.fmtNum(profile.totalComments)}</strong> comments. Tone reads as ${sentLean}; engagement style is <strong>${profile.style}</strong>; audience reception is <strong>${profile.reception}</strong>.</p>`);

    if (perSub.length > 1) {
      const best = perSub[0];
      const worst = perSub[perSub.length - 1];
      parts.push(`<p>Best-performing sub for this campaign so far: <strong>r/${Util.escapeHtml(best.subreddit)}</strong> (${Util.fmtNum(best.totalScore)} pts across ${best.count} post${best.count > 1 ? "s" : ""}, avg ${Util.fmtNum(best.avgScore)}). Lowest: <strong>r/${Util.escapeHtml(worst.subreddit)}</strong> (${Util.fmtNum(worst.totalScore)} pts, avg ${Util.fmtNum(worst.avgScore)}).</p>`);
    }

    if (profile.themes && profile.themes.length) {
      const t = profile.themes[0];
      parts.push(`<p>Dominant theme: <strong>${t.kind === "phrase" ? `"${Util.escapeHtml(t.term)}"` : Util.escapeHtml(t.term)}</strong> (${t.count} post${t.count > 1 ? "s" : ""}, sentiment ${t.sentiment.average.toFixed(2)}).</p>`);
    }

    if (profile.bestHour >= 0) {
      const tz = Util.escapeHtml(Util.getTzLabel());
      const rawPeak = String(profile.bestHour).padStart(2, "0") + ":00";
      const velPeak = profile.bestHourByVelocity >= 0 ? String(profile.bestHourByVelocity).padStart(2, "0") + ":00" : null;
      const disagree = velPeak && Math.abs(profile.bestHour - profile.bestHourByVelocity) >= 4;
      const tail = disagree
        ? ` — but the velocity-corrected peak is <strong>${velPeak}</strong>. The 4+ hour gap suggests the raw peak is a snapshot artifact (older posts at ${rawPeak} had more time to accrue score); trust the velocity peak when planning new posts.`
        : (velPeak ? ` (velocity-corrected peak agrees: ${velPeak}).` : ".");
      parts.push(`<p>Posts in this campaign cluster around <strong>${rawPeak} ${tz}</strong>${tail} Consider matching timing on future cross-posts.</p>`);
    }

    if (comparison && comparison.insights && comparison.insights.length) {
      parts.push(`<p><strong>Why some posts win:</strong> ${comparison.insights[0]}</p>`);
    }

    return parts.join("\n");
  }

  /* ---------- Campaign-derived controls ---------- */

  /* Every control whose options are the campaign list, refreshed from
   * one place. wireCascadeCard, wireVolunteer and wireABCompare each
   * used to carry their own copy of this, run once at boot — so a
   * campaign created afterwards never showed up in any of them. */
  function populateCampaignSelectors() {
    const campaigns = Campaigns.list();
    const esc = Util.escapeHtml;
    const subsOf = (id) => {
      const s = state.campaignSummaries[id];
      return (s && s.subs) || [];
    };

    const setOptions = (id, html) => {
      const el = document.getElementById(id);
      if (!el) return;
      const previous = el.value;
      el.innerHTML = html;
      /* Only restore if the option survived the rebuild, otherwise the
       * select silently blanks out. */
      if (previous && Array.prototype.some.call(el.options, (o) => o.value === previous)) {
        el.value = previous;
      }
    };

    setOptions("discover-campaign", campaigns.length
      ? '<option value="">— pick a campaign —</option>' +
        campaigns.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")
      : '<option value="">(no campaigns saved — create one on the Campaigns tab)</option>');

    /* Cascade and volunteer coverage both work off "a set of subs", so
     * they offer the active dashboard subs alongside each campaign. */
    const sourceOptions = `<option value="__active">Active subs (${state.activeSubs.size})</option>` +
      campaigns.map((c) => `<option value="campaign:${esc(c.id)}">${esc(c.name)} (${subsOf(c.id).length} subs)</option>`).join("");
    setOptions("cascade-source", sourceOptions);
    setOptions("vol-source", sourceOptions);

    const pickOptions = '<option value="">— pick —</option>' +
      campaigns.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
    setOptions("ab-campaign-a", pickOptions);
    setOptions("ab-campaign-b", pickOptions);

    paintCalendar();
  }

  function refreshTargeting(which) {
    const id = which === "ai" ? "targeting-campaign" : "campaigns-targeting-campaign";
    const resultId = which === "ai" ? "targeting-results" : "campaigns-targeting-results";
    const select = document.getElementById(id);
    const out = document.getElementById(resultId);
    if (!select || !out) return;
    const campaignId = select.value || state.targetingFor[which];
    if (!campaignId) {
      out.innerHTML = '<div class="empty">Pick a campaign above to see targeting recommendations.</div>';
      return;
    }
    state.targetingFor[which] = campaignId;
    const campaign = Campaigns.get(campaignId);
    if (!campaign) {
      out.innerHTML = '<div class="empty">Campaign not found.</div>';
      return;
    }
    const summary = state.campaignSummaries[campaign.id];
    if (!summary || !summary.posts || !summary.posts.length) {
      out.innerHTML = `<div class="empty">"${Util.escapeHtml(campaign.name)}" has no resolved posts. Open it on the Campaigns tab and tap Refresh, then revisit.</div>`;
      return;
    }
    const profile = Analysis.campaignProfile(summary.posts, campaign);
    /* Was 10. Full ranked list so the AI Insights / Campaigns-tab
     * targeting card has plenty of depth for pagination. */
    const targets = Analysis.recommendTargets(profile, state.subProfiles, { limit: 200 });
    /* Reset to page 0 on a fresh recompute (campaign change, etc.) so
     * the user lands on the top of the new ranking instead of being
     * stranded on page 5 of the previous campaign's results. */
    if (state.recommend.targeting[which]) state.recommend.targeting[which].page = 0;
    renderTargetingInto(which, campaign, targets, out, { heading: true });
  }

  /* Render a ranked target list and register it as a pageable surface,
   * so the pagination handler can repaint it later without recomputing
   * the ranking. The views call this rather than UI.renderTargeting
   * directly — bookkeeping the caller should not have to remember. */
  function renderTargetingInto(surfaceKey, campaign, targets, container, opts) {
    opts = opts || {};
    state.lastRenderedTargeting[surfaceKey] = { campaign, targets, container, opts };
    UI.renderTargeting(campaign, targets, container, Object.assign({}, opts, {
      surfaceKey: surfaceKey,
      paging: state.recommend.targeting[surfaceKey] || { page: 0, pageSize: 25 },
    }));
  }

  /* Re-render whichever recommendation surface the user just paged
   * through. Looks up the stashed (campaign, targets, container) and
   * calls UI.renderTargeting again with the latest paging state.
   * Avoids re-running Analysis.recommendTargets — pagination is a
   * pure display concern, the ranked list is unchanged. */
  function rerenderTargeting(surfaceKey) {
    const slot = state.lastRenderedTargeting[surfaceKey];
    if (!slot || !slot.campaign || !slot.container) return;
    UI.renderTargeting(slot.campaign, slot.targets, slot.container, Object.assign({}, slot.opts || {}, {
      surfaceKey,
      paging: state.recommend.targeting[surfaceKey] || { page: 0, pageSize: 25 },
    }));
  }
  /* Everything the discovery panel shows comes from one stashed result,
   * so one function paints all of it. A fresh run, a Relevant/All toggle
   * and a page change all land here, which is what keeps the candidate
   * lists, the status line and the sphere chips describing the same set
   * of numbers instead of drifting apart. */
  function rerenderDiscovery() {
    const result = state.lastDiscoverResult;
    const out = document.getElementById("discover-results");
    if (!result || !out) return;
    UI.renderDiscoveryCandidates(result, out, Object.assign({}, state.lastDiscoverCtx || {}, {
      paging: {
        new:     state.recommend.discover.new,
        already: state.recommend.discover.already,
      },
    }));
    renderSphereSuggestions(result);
    updateSphereChipScores(result);
    renderDiscoverStatus(result);
  }

  function renderDiscoverStatus(result) {
    const el = document.getElementById("discover-status");
    if (!el) return;
    const f = result.filtered || {};
    const dropped = (f.offtopic || 0) + (f.weak || 0) + (f.mega || 0);
    const sub = (n) => (n === 1 ? "subreddit" : "subreddits");

    const parts = [];
    parts.push(result.candidates.length
      ? `Found <strong>${result.candidates.length}</strong> new ${sub(result.candidates.length)} out of ${result.totalScanned} scanned`
      : `Scanned ${result.totalScanned} ${sub(result.totalScanned)} — nothing new cleared the bar`);
    if (result.alreadyLoaded.length) {
      parts.push(`${result.alreadyLoaded.length} of your loaded subs also ranked`);
    }
    if (dropped) {
      parts.push(`${dropped} off-topic or over-broad ${dropped === 1 ? "match" : "matches"} filtered out — switch to <em>All</em> to see them`);
    }
    const terms = (result.topTerms || []).slice(0, 6).map((t) => `<code>${Util.escapeHtml(t)}</code>`);
    if (terms.length) parts.push(`matched on ${terms.join(" ")}`);

    el.hidden = false;
    el.className = "meta " + (result.candidates.length ? "ok" : "warn");
    el.innerHTML = parts.join(" · ") + ".";
  }

  /* The spheres the campaign's own vocabulary scored against, with the
   * words that earned each one. Clicking pins a sphere so its whole
   * catalog seeds the next run even if the campaign's own text never
   * mentions it — the manual override for "I know I want Texas too". */
  function renderSphereSuggestions(result) {
    const el = document.getElementById("sphere-suggestions");
    if (!el) return;
    const auto = (result && result.autoSpheres) || [];
    if (!auto.length) {
      el.innerHTML = '<span class="meta">Run Discover and the issue spheres your campaign reads as will appear here.</span>';
      return;
    }
    el.innerHTML = auto.map((s) => {
      const pinned = state.activeSpheres.includes(s.key);
      const terms = (s.terms || []).slice(0, 4).join(", ");
      const tip = terms
        ? `Matched on ${terms}${pinned ? " · already pinned" : " · click to pin"}`
        : (pinned ? "Already pinned" : "Click to pin");
      return `<button type="button" class="chip sphere-suggestion${pinned ? " active" : ""}"
        data-action="pin-sphere" data-sphere-key="${Util.escapeHtml(s.key)}"
        title="${Util.escapeHtml(tip)}" aria-pressed="${pinned}">
        ${Util.escapeHtml(s.label)}<span class="chip-meta">${s.confidence}%</span></button>`;
    }).join("");
  }

  /* ---------- Wire UI ---------- */

  function populateTransportSelect(select) {
    if (!select) return;
    select.innerHTML = "";
    for (const t of Reddit.TRANSPORTS) {
      const opt = document.createElement("option");
      opt.value = t.name;
      opt.textContent = t.label;
      select.appendChild(opt);
    }
    select.value = Reddit.getTransport();
  }

  /* ============ Active sphere picker (Discover hero) ============ */

  function persistSpheres() {
    try { localStorage.setItem("rj.activeSpheres", JSON.stringify(state.activeSpheres)); } catch (_) {}
  }

  function populateSphereDropdowns() {
    if (typeof Seeds === "undefined") return;
    function fill(id, entries) {
      const sel = document.getElementById(id);
      if (!sel) return;
      /* keep the first placeholder option, drop the rest */
      while (sel.options.length > 1) sel.remove(1);
      const sorted = entries.slice().sort((a, b) => a[1].localeCompare(b[1]));
      for (const [key, label] of sorted) {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = label;
        sel.appendChild(opt);
      }
    }
    fill("sphere-add-issue", Object.entries(Seeds.ISSUE_LABELS || {}));
    fill("sphere-add-state", Object.entries(Seeds.STATE_LABELS || {}));
    fill("sphere-add-audience", Object.entries(Seeds.DEMOGRAPHIC_LABELS || {}));
  }

  function renderActiveSpheres() {
    const el = document.getElementById("active-spheres");
    if (!el) return;
    if (!state.activeSpheres.length) {
      el.innerHTML = '<span class="meta">No manual spheres added — Discover auto-detects from your campaign content.</span>';
      return;
    }
    el.innerHTML = state.activeSpheres.map((key) => {
      const subs = (typeof Seeds !== "undefined") ? Seeds.expand([key]) : [];
      const label = (typeof Seeds !== "undefined") ? Seeds.labelOf(key) : key;
      return `<span class="chip active sphere-chip" data-sphere-key="${Util.escapeHtml(key)}">${Util.escapeHtml(label)}<span class="chip-meta" data-sphere-meta>${subs.length} sub${subs.length === 1 ? "" : "s"}</span><span class="x" data-action="remove-sphere" data-sphere-key="${Util.escapeHtml(key)}" aria-label="Remove sphere">×</span></span>`;
    }).join("");
  }

  function addSphere(key) {
    if (!key || state.activeSpheres.includes(key)) return;
    state.activeSpheres.push(key);
    persistSpheres();
    renderActiveSpheres();
  }

  function removeSphere(key) {
    state.activeSpheres = state.activeSpheres.filter((k) => k !== key);
    persistSpheres();
    renderActiveSpheres();
  }

  /* After Discover finishes, surface per-sphere effectiveness on each
   * chip: how many candidates from that sphere came back, and the
   * average fit score across them. Hits BOTH the new and already-loaded
   * sections so a chip whose subs are all already in the dashboard
   * still reads "5 subs · avg fit 71". */
  function updateSphereChipScores(result) {
    if (typeof Seeds === "undefined") return;
    const all = [].concat(result.candidates || [], result.alreadyLoaded || []);
    const byCanonical = new Map();
    for (const c of all) byCanonical.set(c.key, c);

    document.querySelectorAll(".sphere-chip").forEach((chip) => {
      const key = chip.dataset.sphereKey;
      const meta = chip.querySelector("[data-sphere-meta]");
      if (!key || !meta) return;
      const expected = Seeds.expand([key]).map((s) => s.toLowerCase());
      const matched = expected.map((s) => byCanonical.get(s)).filter(Boolean);
      if (!matched.length) {
        meta.textContent = `${expected.length} sub${expected.length === 1 ? "" : "s"} · no matches`;
        chip.classList.remove("strong", "weak");
        return;
      }
      const avg = Math.round(matched.reduce((sum, x) => sum + x.score, 0) / matched.length);
      meta.textContent = `${matched.length} sub${matched.length === 1 ? "" : "s"} · avg fit ${avg}`;
      chip.classList.toggle("strong", avg >= 50);
      chip.classList.toggle("weak", avg < 30);
    });
  }

    /* Keep both per-tab sub-filter dropdowns synced with the currently
   * loaded subreddits. Preserves the user's selection if their picked
   * sub is still loaded. */
  function refreshSubFilterDropdowns() {
    const subs = Array.from(state.activeSubs).sort();
    function fill(id, current) {
      const sel = document.getElementById(id);
      if (!sel) return;
      const want = current || "";
      while (sel.options.length > 1) sel.remove(1);
      for (const sub of subs) {
        const opt = document.createElement("option");
        opt.value = sub;
        opt.textContent = "r/" + sub;
        sel.appendChild(opt);
      }
      if (want && subs.includes(want)) sel.value = want;
      else sel.value = "";
    }
    fill("posts-sub-filter", state.postsSubFilter);
    fill("crossposts-sub-filter", state.crossPostsSubFilter);
  }

  /* ============================================================
   * Cross-device session sync (campaigns, subs, spheres, prefs).
   * Three flows wired here:
   *   - Copy share link  -> base64url-encoded payload in URL fragment
   *   - Download JSON    -> .json file via Blob
   *   - Import           -> paste string OR pick file; merge or replace
   * Plus an init-time check: if location.hash carries a session=...
   * payload, we offer to import it via a banner above the dashboard.
   * ============================================================ */
  function setSyncStatus(msg, kind) {
    const el = document.getElementById("sync-status");
    if (!el) return;
    el.className = "meta " + (kind || "");
    el.textContent = msg || "";
  }

  function setImportStatus(msg, kind) {
    const el = document.getElementById("sync-import-status");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.className = "meta " + (kind || "");
    el.textContent = msg;
  }

  /* Backward-compatible local alias — the implementation lives in
   * util.js as Util.copyToClipboard so other modules (composer,
   * sync, etc.) can share the same iOS-Safari-gesture-safe code
   * path. Existing callers in this file still use the bare name
   * via this alias.
   *
   * Wrapped in a function (rather than a direct const = …) so it
   * works regardless of script-load order; if util.js hasn't
   * finished evaluating yet at IIFE-time, we still resolve to the
   * latest Util.copyToClipboard at call time. */
  async function copyToClipboard(textOrPromise) {
    if (typeof Util !== "undefined" && Util.copyToClipboard) {
      return Util.copyToClipboard(textOrPromise);
    }
    /* Local fallback is intentionally tiny — primary path is
     * Util's robust three-fallback implementation. This branch
     * only fires if util.js failed to load at all. */
    try {
      const t = (textOrPromise && typeof textOrPromise.then === "function")
        ? await textOrPromise : String(textOrPromise);
      await navigator.clipboard.writeText(t);
      return true;
    } catch (_) {
      return false;
    }
  }

  function downloadBlob(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  /* Strip every recognised share-payload fragment from the URL without
   * triggering a navigation. Handles BOTH formats:
   *   #s=…       new short (gzip + compact array)        — PR #45
   *   #session=… legacy verbose                          — pre-PR #45
   * Idempotent + tolerant of multi-fragment hashes (#a=1&s=…&b=2).
   * Returns true if the URL was modified, false otherwise. */
  function clearShareHashFromUrl() {
    if (typeof location === "undefined") return false;
    const before = location.hash || "";
    if (!/(?:^|[#&])(?:s|session)=/.test(before)) return false;
    try {
      const url = new URL(location.href);
      url.hash = url.hash
        .replace(/(?:^|[#&])s=[^&]+/, "")
        .replace(/(?:^|[#&])session=[^&]+/, "")
        .replace(/^#&/, "#")
        .replace(/^#$/, "");
      history.replaceState(null, "", url.pathname + url.search + (url.hash || ""));
      return true;
    } catch (_) { return false; }
  }

  /* Dismiss the in-page session-import banner if it's currently shown.
   * Used by the brand-home click handler so a single tap of the logo
   * clears both the visual banner AND the URL fragment that produces
   * it on reload. */
  function dismissSessionImportBanner() {
    const banner = document.getElementById("sync-import-banner");
    if (banner) banner.remove();
  }

  function showSessionImportBanner(decoded, encoded) {
    const main = document.querySelector("main");
    if (!main) return;
    /* If we already have one displayed, replace its contents. */
    let banner = document.getElementById("sync-import-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "sync-import-banner";
      banner.className = "banner info sync-banner";
      main.insertBefore(banner, main.firstChild);
    }
    const ts = decoded.ts ? new Date(decoded.ts).toLocaleString() : "unknown";
    const cn = (decoded.campaigns || []).length;
    const sn = ((decoded.subs && decoded.subs.active) || []).length;
    banner.innerHTML = `
      <strong>Found a shared session in this URL.</strong>
      ${cn} campaign${cn === 1 ? "" : "s"} · ${sn} active sub${sn === 1 ? "" : "s"} · saved ${Util.escapeHtml(ts)}.
      <div class="sync-banner-actions">
        <button class="btn small primary" data-action="sync-import-merge">Merge into mine</button>
        <button class="btn small" data-action="sync-import-replace">Replace mine</button>
        <button class="btn small ghost" data-action="sync-import-cancel">Dismiss</button>
      </div>
    `;
    function done() {
      banner.remove();
      /* Strip BOTH share-payload formats so a reload doesn't re-prompt
       * regardless of whether the link was the new `#s=…` short URL
       * or the legacy `#session=…` verbose one. */
      clearShareHashFromUrl();
    }
    banner.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest && e.target.closest("[data-action]");
      if (!btn) return;
      e.preventDefault();
      const action = btn.dataset.action;
      try {
        if (action === "sync-import-merge" || action === "sync-import-replace") {
          const stats = Sync.applyPayload(decoded, { mode: action === "sync-import-merge" ? "merge" : "replace" });
          done();
          /* Force-reload state from storage and refresh everything. */
          loadPersisted();
          renderChips();
          rerenderAll();
          refreshAllCampaignSummaries();
          if (action === "sync-import-replace") refreshData(true);
          Util.toast(`Imported ${stats.campaignsAdded} campaign${stats.campaignsAdded === 1 ? "" : "s"} (${stats.mode}).`, "ok");
        } else if (action === "sync-import-cancel") {
          done();
          Util.toast("Session import dismissed.", "ok");
        }
      } catch (err) {
        console.warn("[sync] import banner action failed:", err && err.message);
        Util.toast(`Couldn't import session: ${(err && err.message) || err}`, "error");
      }
    });
  }

  /* Session modal — opens via the topbar 'Session' button.
   * Closes on backdrop click, [data-action=close-session-modal] click,
   * Escape, or after a successful import. */
  function openSessionModal() {
    const modal = document.getElementById("session-modal");
    if (!modal) return;
    modal.hidden = false;
    /* Focus the first interactive element so keyboard users land inside. */
    const first = modal.querySelector("button, input, textarea, select, a");
    if (first) try { first.focus({ preventScroll: true }); } catch (_) {}
    document.body.classList.add("modal-open");
  }

  function closeSessionModal() {
    const modal = document.getElementById("session-modal");
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("modal-open");
    /* Return focus to the toggle for keyboard users. */
    const toggle = document.getElementById("session-toggle");
    if (toggle) try { toggle.focus({ preventScroll: true }); } catch (_) {}
  }

  function wireSessionModal() {
    const toggle = document.getElementById("session-toggle");
    const modal = document.getElementById("session-modal");
    if (toggle && modal) {
      toggle.addEventListener("click", (e) => {
        e.preventDefault();
        if (modal.hidden) openSessionModal(); else closeSessionModal();
      });
      modal.addEventListener("click", (e) => {
        const closer = e.target && e.target.closest && e.target.closest('[data-action="close-session-modal"]');
        if (closer) {
          e.preventDefault();
          closeSessionModal();
        }
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !modal.hidden) closeSessionModal();
      });
    }
  }

  function wireSyncSession() {
    if (typeof Sync === "undefined") return;

    wireSessionModal();

    /* On init: if URL has a session payload, surface a banner.
     * parseHashPayload is async because the new short format may
     * need DecompressionStream-gunzip. We don't block init on it —
     * the banner pops in a few ms after the rest of the UI mounts. */
    Sync.parseHashPayload()
      .then((found) => {
        if (found && found.payload) {
          showSessionImportBanner(found.payload, found.encoded);
        }
      })
      .catch((err) => {
        console.warn("[sync] hash parse failed:", err && err.message);
      });

    const linkBtn = document.getElementById("sync-copy-link");
    const jsonBtn = document.getElementById("sync-export-json");
    const showImportBtn = document.getElementById("sync-show-import");
    const panel = document.getElementById("sync-import-panel");
    const ta = document.getElementById("sync-import-text");
    const fileInput = document.getElementById("sync-import-file");
    const applyBtn = document.getElementById("sync-import-apply");
    const mergeBox = document.getElementById("sync-import-merge");

    if (linkBtn) linkBtn.addEventListener("click", async () => {
      try {
        /* CRITICAL on iOS Safari: pass the Sync.toShareUrl() promise
         * DIRECTLY into copyToClipboard so the ClipboardItem-with-Promise
         * code path can preserve the user-gesture context across the
         * async gzip step. Awaiting toShareUrl first then calling
         * writeText breaks the gesture and Safari throws NotAllowedError.
         *
         * We also keep a reference to the promise so we can `await` it
         * AFTER the clipboard call to format the success message. By
         * then the value is cached in the resolved promise so this is
         * essentially free. */
        const urlPromise = Sync.toShareUrl();
        const ok = await copyToClipboard(urlPromise);
        const url = await urlPromise;
        const len = url.length;
        if (ok) {
          setSyncStatus(`Short share link copied (${len.toLocaleString()} chars). Paste it on another device — works in Signal, iMessage, etc.`, "ok");
          Util.toast("Share link copied to clipboard.", "ok");
        } else {
          /* Every clipboard path failed — show the URL inline,
           * unhide the import panel (which holds the textarea),
           * focus it, and select all so the user can hit ⌘C / iOS
           * "Copy" from the context menu in one tap. */
          setSyncStatus("Could not access clipboard — link shown below; tap & hold to copy.", "err");
          if (panel) panel.hidden = false;
          if (ta) {
            ta.value = url;
            try {
              ta.focus();
              ta.setSelectionRange(0, url.length);
              ta.scrollIntoView({ behavior: "smooth", block: "center" });
            } catch (_) {}
          }
        }
        /* New short format uses gzip + compact schema so a typical
         * session is well under a kilobyte. The 4 KB threshold below
         * is conservative — only gigantic campaign sets (hundreds of
         * post IDs) would ever exceed it. */
        if (len > 4000) {
          setSyncStatus("Heads up: link is " + len.toLocaleString() + " chars. Some chat apps truncate URLs over a few kilobytes — Download JSON is more reliable for very large sessions.", "warn");
        }
      } catch (err) {
        setSyncStatus("Couldn't build share link: " + ((err && err.message) || err), "err");
      }
    });

    if (jsonBtn) jsonBtn.addEventListener("click", () => {
      try {
        const payload = Sync.collectPayload();
        const text = JSON.stringify(payload, null, 2);
        const stamp = new Date().toISOString().slice(0, 10);
        downloadBlob(`reddit-campaign-reporter-session-${stamp}.json`, text);
        setSyncStatus(`Downloaded session (${payload.campaigns.length} campaign${payload.campaigns.length === 1 ? "" : "s"}, ${(payload.subs && payload.subs.active || []).length} active subs).`, "ok");
      } catch (err) {
        setSyncStatus("Couldn't export: " + ((err && err.message) || err), "err");
      }
    });

    /* Copy JSON to clipboard — alternative to Download for users who'd
     * rather paste between devices via iCloud Universal Clipboard or
     * any chat app. */
    const copyJsonBtn = document.getElementById("sync-copy-json");
    if (copyJsonBtn) copyJsonBtn.addEventListener("click", async () => {
      try {
        const payload = Sync.collectPayload();
        const text = JSON.stringify(payload, null, 2);
        const ok = await copyToClipboard(text);
        if (ok) {
          setSyncStatus(`JSON copied (${text.length.toLocaleString()} chars · ${payload.campaigns.length} campaign${payload.campaigns.length === 1 ? "" : "s"}). Paste into Import on another device.`, "ok");
          Util.toast("Session JSON copied to clipboard.", "ok");
        } else {
          setSyncStatus("Could not access clipboard — JSON shown below; long-press to copy.", "err");
          if (ta) ta.value = text;
          if (panel) panel.hidden = false;
        }
      } catch (err) {
        setSyncStatus("Couldn't copy JSON: " + ((err && err.message) || err), "err");
      }
    });

    if (showImportBtn && panel) showImportBtn.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && ta) ta.focus();
    });

    if (fileInput && ta) fileInput.addEventListener("change", () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        ta.value = String(reader.result || "");
        setImportStatus(`Loaded ${f.name} (${Math.round(f.size / 1024 * 10) / 10} KB). Tap Apply to import.`, "ok");
      };
      reader.onerror = () => setImportStatus("Couldn't read file.", "err");
      reader.readAsText(f);
    });

    if (applyBtn && ta) applyBtn.addEventListener("click", async () => {
      const raw = (ta.value || "").trim();
      if (!raw) { setImportStatus("Paste a share link or session JSON first.", "err"); return; }
      /* Single dispatcher recognises new short URLs (#s=…), legacy
       * URLs (#session=…), bare base64 of either, or raw JSON.
       * Async because the short format may need DecompressionStream. */
      let result;
      try { result = await Sync.decodeFromAnyText(raw); }
      catch (err) { setImportStatus("Couldn't import: " + ((err && err.message) || err), "err"); return; }
      const payload = result && result.payload;
      if (!payload) { setImportStatus("Couldn't recognise that as a session. Paste a share link, a JSON blob, or upload a downloaded file.", "err"); return; }
      try {
        const stats = Sync.applyPayload(payload, { mode: mergeBox && mergeBox.checked ? "merge" : "replace" });
        loadPersisted();
        renderChips();
        rerenderAll();
        refreshAllCampaignSummaries();
        if (!mergeBox || !mergeBox.checked) refreshData(true);
        const fmtNote = result.format === "short" ? " · short format" : (result.format === "legacy" ? " · legacy format" : "");
        setImportStatus(`Imported${fmtNote} · ${stats.campaignsAdded} campaign${stats.campaignsAdded === 1 ? "" : "s"} added (${stats.mode}). Active subs: ${stats.activeSubs}.`, "ok");
        Util.toast(`Imported session (${stats.mode}).`, "ok");
        ta.value = "";
        if (fileInput) fileInput.value = "";
      } catch (err) {
        setImportStatus("Couldn't import: " + ((err && err.message) || err), "err");
      }
    });
  }

  function bind() {
    const transportSelect = document.getElementById("transport-select");
    populateTransportSelect(transportSelect);

    /* Custom-proxy URL inputs. Visible when:
     *   - the user picks "Custom (your CORS proxy)" from Data source, OR
     *   - they've already pasted a URL (so they can re-edit even on auto)
     *
     * The input is paired with localStorage via Reddit.{get,set}CustomProxyUrl.
     * Cross-device sharing rides through the existing Sync payload. */
    const customInput = document.getElementById("custom-proxy-input");

    function syncCustomInputVisibility() {
      const t = Reddit.getTransport();
      const haveUrl = !!Reddit.getCustomProxyUrl();
      const visible = t === "custom" || haveUrl;
      if (customInput) {
        customInput.hidden = !visible;
        customInput.value = Reddit.getCustomProxyUrl();
      }
    }

    function onCustomProxyChange(e) {
      const v = String(e.target.value || "").trim();
      Reddit.setCustomProxyUrl(v);
      if (customInput && customInput !== e.target) customInput.value = v;
      Reddit.clearCache();
      if (typeof Reddit.resetCircuitBreaker === "function") Reddit.resetCircuitBreaker();
      Util.toast(v ? "Custom proxy saved" : "Custom proxy cleared", "ok");
      markPending();
    }

    if (customInput) {
      customInput.addEventListener("change", onCustomProxyChange);
      customInput.addEventListener("blur", onCustomProxyChange);
    }

    syncCustomInputVisibility();

    /* Dismiss button on the "Reddit blocked" suggestion banner.
     * Once dismissed it stays hidden until the user reloads the tab,
     * matching the behavior of the share-import banner. */
    const proxyDownDismiss = document.getElementById("proxy-down-banner-dismiss");
    if (proxyDownDismiss) {
      proxyDownDismiss.addEventListener("click", dismissProxyDownBanner);
    }
    /* The banner's one-tap fix. Pinning the archive explicitly, rather
     * than leaving it on auto, stops the chain from spending seconds on
     * the proxies we just told the user are refused. */
    const proxyDownSwitch = document.getElementById("proxy-down-banner-switch");
    if (proxyDownSwitch) {
      proxyDownSwitch.addEventListener("click", () => {
        Reddit.setTransport("archive");
        if (transportSelect) transportSelect.value = "archive";
        syncCustomInputVisibility();
        Reddit.clearCache();
        dismissProxyDownBanner();
        Util.toast("Reading from the Reddit archive", "ok");
        refreshData(true);
      });
    }

    function onTransportChange(e) {
      const v = e.target.value;
      Reddit.setTransport(v);
      if (transportSelect && transportSelect !== e.target) transportSelect.value = v;
      syncCustomInputVisibility();
      Reddit.clearCache();
      Util.toast(`Data source: ${v}`, "ok");
      refreshData(true);
    }
    if (transportSelect) transportSelect.addEventListener("change", onTransportChange);

    Reddit.onTransportSuccess = function (name) { state.lastTransport = name; };

    /* Per-proxy health dashboard. Renders into #proxy-health in the
     * footer with a small status pill per transport showing recent
     * success rate ("codetabs ✓ 100% · allorigins ⚠ 60% blocked").
     * Updates after every fetch attempt via Reddit.onTransportStats. */
    Reddit.onTransportStats = function (statsByTransport) {
      const el = document.getElementById("proxy-health");
      const entries = Object.entries(statsByTransport || {});

      /* --- The visible health pills in the footer --- */
      if (el) {
        if (!entries.length) {
          el.hidden = true;
        } else {
          el.hidden = false;
          const pills = entries.map(([name, s]) => {
            const recent = (s.recent || []).slice(-20);
            const total = recent.length || (s.ok + s.fail);
            const ok = recent.length ? recent.filter((x) => x).length : s.ok;
            const rate = total ? ok / total : 1;
            const cls = rate >= 0.9 ? "ok" : rate >= 0.5 ? "warn" : "bad";
            const sym = rate >= 0.9 ? "✓" : rate >= 0.5 ? "⚠" : "✗";
            const tail = (rate < 1 && s.lastKind) ? ` · last: ${s.lastKind}` : "";
            const tip = `${s.ok} ok / ${s.fail} fail (last ${total})${tail}`;
            return `<span class="proxy-pill ${cls}" title="${Util.escapeHtml(tip)}">${sym} ${Util.escapeHtml(name)} <strong>${Math.round(rate * 100)}%</strong></span>`;
          });
          el.innerHTML = `<span class="proxy-health-label">Proxy health:</span>${pills.join("")}`;
        }
      }

      /* --- The "deploy a Cloudflare Worker" suggestion banner ---
       * Triggered when the public proxies are demonstrably failing
       * AND the user hasn't already set up their own. The banner
       * stays dismissable; once dismissed it doesn't return until
       * the user opens a fresh tab. */
      maybeShowProxyDownBanner(statsByTransport);
    };

    /* Settings sheet — one dialog for fetch settings, data source,
     * appearance and cache controls. */
    for (const id of ["settings-toggle", "settings-toggle-mobile"]) {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener("click", () => setSettingsOpen(!settingsAreOpen()));
    }
    const settingsClose = document.getElementById("settings-close");
    if (settingsClose) settingsClose.addEventListener("click", () => setSettingsOpen(false));
    const settingsBackdrop = document.getElementById("settings-sheet-backdrop");
    if (settingsBackdrop) settingsBackdrop.addEventListener("click", () => setSettingsOpen(false));

    /* Navigation drawer on mobile. */
    const railToggle = document.getElementById("rail-toggle");
    if (railToggle) railToggle.addEventListener("click", () => setRailOpen(true));
    Router.onChange(() => setRailOpen(false));

    wireTheme();

    /* Brand button — same affordance as a logo home link. Activates
     * the Overview tab and scrolls the page to the top so the user
     * gets back to the highest-level summary in one tap.
     *
     * Also clears any share-link fragment from the URL (#s=… or
     * #session=…) and dismisses the in-page import banner. Without
     * this, every refresh after a friend opened a shared link would
     * keep re-prompting "Found a shared session in this URL" — even
     * after they've already accepted or dismissed it. The brand tap
     * is the natural moment to say "I'm done with that link, this is
     * my dashboard now". */
    const brandHome = document.getElementById("brand-home");
    if (brandHome) brandHome.addEventListener("click", () => {
      try { Router.go("dashboard"); } catch (_) {}
      try { clearShareHashFromUrl(); } catch (_) {}
      try { dismissSessionImportBanner(); } catch (_) {}
      try { window.scrollTo({ top: 0, behavior: "smooth" }); }
      catch (_) { window.scrollTo(0, 0); }
    });

    /* The single ACTION button inside the action banner. Same handler
     * regardless of which phase the banner is showing — the button is
     * always "fetch / refetch with current settings". CSS + the phase
     * class flip the icon and label between Go ▶ / Loading… / Refresh ↻. */
    const actionBtn = document.getElementById("action-btn");
    if (actionBtn) actionBtn.addEventListener("click", () => {
      if (actionBtn.disabled) return;
      /* User tapped Refresh — clear the proxy circuit breaker so we
       * give the chain a fresh chance even if it's been auto-failing. */
      if (Reddit.clearCircuitBreaker) Reddit.clearCircuitBreaker();
      refreshData(true);
    });

    /* "Clear cache" is a soft cache reset. It wipes Reddit's request
     * memCache (so the next fetch hits network instead of in-page
     * cache) and trips the circuit breaker, but preserves the
     * persistent post cache so the user's existing dataset stays
     * visible. For a hard reset that also wipes the persistent
     * post cache, use the "Full reset" entry below — typically
     * exposed via shift-click on Clear cache or via a confirm()
     * dialog when the user holds the option key. We keep the
     * default behavior soft because it's the more common case
     * (refresh the request layer, keep the data). */
    function softClearCache() {
      Reddit.clearCache();
      if (Reddit.clearCircuitBreaker) Reddit.clearCircuitBreaker();
      Util.toast("Cache cleared. Tap Refresh to re-fetch.", "ok");
    }
    /* Full reset: wipes BOTH Reddit's request cache AND the on-disk
     * persistent post cache. Drops state.posts so the next refresh
     * starts from scratch. Triggered by shift+click on Clear cache,
     * or programmatically via the confirm() in the action banner. */
    function fullReset() {
      Reddit.clearCache();
      if (Reddit.clearCircuitBreaker) Reddit.clearCircuitBreaker();
      /* PostCache.clear is async (IndexedDB transaction). Use the
       * sync helper here so the UI reflects the wipe immediately;
       * the IDB clear fires fire-and-forget in the background. */
      if (typeof PostCache !== "undefined") {
        if (typeof PostCache.clearSync === "function") PostCache.clearSync();
        else { try { PostCache.clear(); } catch (_) {} }
      }
      state.cache.hasCache = false;
      state.cache.savedAt = 0;
      state.cache.cachedCount = 0;
      state.posts = [];
      rerenderAll();
      Util.toast("Full reset — all cached posts cleared. Tap Go to fetch fresh data.", "ok");
      Util.setActionPhase("pending", describePendingFetch());
      state.pendingChanges = true;
    }

    const clearBtn = document.getElementById("clear-cache-btn");
    if (clearBtn) clearBtn.addEventListener("click", (e) => {
      /* Shift-click = full reset (also wipes persistent post cache).
       * Plain click = soft (request-cache only).
       * Discoverable via the title attribute on the button. */
      if (e.shiftKey) fullReset(); else softClearCache();
    });
    /* Full reset button (separate, explicit). Lets users on touch
     * devices (no shift key) wipe everything cleanly, and surfaces
     * the destructive action visually so first-time users discover
     * it. Wired below to a button we add to the topbar in HTML. */
    const fullResetBtn = document.getElementById("full-reset-btn");
    if (fullResetBtn) fullResetBtn.addEventListener("click", () => {
      if (!state.posts.length) { fullReset(); return; }
      if (confirm("Full reset will discard all cached posts (" + state.posts.length + " in view) and re-fetch from scratch. Continue?")) {
        fullReset();
      }
    });
    /* Filter changes (listing / time / limit) no longer auto-trigger
     * a fetch. They mark the dataset stale and reveal the Go banner;
     * the user opts into refetching with one explicit click. */
    document.getElementById("listing-select").addEventListener("change", (e) => {
      state.listing = e.target.value; persist(); markPending("Listing changed");
    });
    document.getElementById("time-select").addEventListener("change", (e) => {
      state.timeWindow = e.target.value; persist(); markPending("Time window changed");
    });
    document.getElementById("limit-select").addEventListener("change", (e) => {
      state.limit = Number(e.target.value); persist(); markPending("Per-sub limit changed");
    });

    document.getElementById("listing-select").value = state.listing;
    document.getElementById("time-select").value = state.timeWindow;
    document.getElementById("limit-select").value = String(state.limit);

    /* Wired here rather than in the Communities view because that view
     * mounts lazily, and this button lives in the always-visible scope
     * bar. */
    const scopeAdd = document.getElementById("scope-add-sub");
    if (scopeAdd) scopeAdd.addEventListener("click", () => CommunitiesView.openSearch());

    const debouncedFilter = Util.debounce(() => { rerenderAll(); }, 200);
    function renderPastePreview(targetId, ids, opts) {
      const el = document.getElementById(targetId);
      if (!el) return;
      opts = opts || {};
      if (!ids || !ids.length) {
        el.hidden = true;
        el.innerHTML = "";
        return;
      }
      el.hidden = false;
      const chips = ids.slice(0, opts.max || 80).map((id) => `<span class="kw"><code>${Util.escapeHtml(id)}</code></span>`).join("");
      const moreNote = ids.length > (opts.max || 80) ? ` <span class="meta">(+${ids.length - (opts.max || 80)} more)</span>` : "";
      const heading = opts.short
        ? `<span class="meta">${ids.length} ID${ids.length === 1 ? "" : "s"} detected</span>`
        : `<div class="meta">Detected ${ids.length} post ID${ids.length === 1 ? "" : "s"} from your paste</div>`;
      el.innerHTML = heading + chips + moreNote;
    }

    const postIdInput = document.getElementById("post-id-filter");
    postIdInput.addEventListener("input", (e) => {
      const ids = Util.parseIdList(e.target.value);
      state.postIdFilter = ids;
      state.postsPage = 0;
      renderPastePreview("post-id-filter-preview", ids, { short: true, max: 30 });
      debouncedFilter();
    });
    postIdInput.addEventListener("paste", () => {
      // The input event fires *after* paste in modern browsers but on some
      // mobile keyboards it lags; this guarantees a refresh on next tick.
      setTimeout(() => postIdInput.dispatchEvent(new Event("input")), 0);
    });

    const campaignIdsTa = document.getElementById("campaign-post-ids");
    if (campaignIdsTa) {
      const update = () => {
        const refs = Util.parsePostRefs(campaignIdsTa.value);
        const el = document.getElementById("campaign-post-ids-preview");
        if (!el) return;
        if (!refs.ids.length && !refs.shares.length) {
          el.hidden = true; el.innerHTML = ""; return;
        }
        el.hidden = false;
        const idChips = refs.ids.slice(0, 80).map((id) =>
          `<span class="kw"><code>${Util.escapeHtml(id)}</code></span>`
        ).join("");
        const shareChips = refs.shares.slice(0, 40).map((s) =>
          `<span class="kw share" title="${Util.escapeHtml(s.url)} — will be resolved on Save"><code>r/${Util.escapeHtml(s.sub)}/s/${Util.escapeHtml(s.token)}</code></span>`
        ).join("");
        const headParts = [];
        if (refs.ids.length) headParts.push(`<strong>${refs.ids.length}</strong> ID${refs.ids.length === 1 ? "" : "s"} ready`);
        if (refs.shares.length) headParts.push(`<span style="color:var(--warn)">${refs.shares.length} share URL${refs.shares.length === 1 ? "" : "s"} — will be resolved on Save</span>`);
        el.innerHTML = `<div class="meta">${headParts.join(" · ")}</div>${idChips}${shareChips}`;
      };
      campaignIdsTa.addEventListener("input", update);
      campaignIdsTa.addEventListener("paste", () => setTimeout(update, 0));
    }
    document.getElementById("search-input").addEventListener("input", (e) => {
      state.searchQuery = e.target.value.trim();
      state.postsPage = 0;
      const tabSearch = document.getElementById("posts-title-search");
      if (tabSearch && tabSearch.value !== e.target.value) tabSearch.value = e.target.value;
      debouncedFilter();
    });

    /* Posts-over-time mode toggle (Per sub / Stacked / Density / Total) */
    document.querySelectorAll("#timeline-card .chart-mode:not(.chart-window) button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const m = btn.dataset.mode;
        if (!m || m === state.timelineMode) return;
        state.timelineMode = m;
        document.querySelectorAll("#timeline-card .chart-mode:not(.chart-window) button").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", b === btn ? "true" : "false");
        });
        rerenderAll();
      });
    });

    /* Posts-over-time window picker (1d / 3d / 7d / 30d / 90d / All) */
    document.querySelectorAll("#timeline-card .chart-window button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const w = btn.dataset.window;
        if (!w || w === state.timelineWindow) return;
        state.timelineWindow = w;
        document.querySelectorAll("#timeline-card .chart-window button").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", b === btn ? "true" : "false");
        });
        rerenderAll();
      });
    });

    /* Collapsible cards. Any element with [data-collapsible] gets a
     * chevron in its card-header; click toggles .collapsed. Cards with
     * [data-collapsed-default] start hidden so first-load is calm. */
    /* Card-help "?" tooltip — viewport-aware shared popover.
     *
     * Earlier version used a CSS pseudo-element on the button with
     * `right: -4px`, which only worked when the button sat near the
     * right edge of the screen. When a card-header laid the button on
     * the LEFT (e.g. the narrative card on Overview), the popover
     * extended past the left viewport edge and got clipped.
     *
     * New approach: a single fixed-position <div> shared across all
     * help buttons. We measure the button's bounding rect on show and
     * place the popover so it stays inside the viewport — preferred
     * placement is below + right-aligned with the button, fallback to
     * left-alignment, and ultimately centered. The pointer triangle
     * slides along the top edge so it always points at the button.
     */
    let helpTooltip = document.getElementById("card-help-tooltip");
    if (!helpTooltip) {
      helpTooltip = document.createElement("div");
      helpTooltip.id = "card-help-tooltip";
      helpTooltip.className = "card-help-tooltip";
      helpTooltip.setAttribute("role", "tooltip");
      helpTooltip.hidden = true;
      const inner = document.createElement("div");
      inner.className = "card-help-tooltip-body";
      const pointer = document.createElement("span");
      pointer.className = "card-help-tooltip-pointer";
      helpTooltip.appendChild(pointer);
      helpTooltip.appendChild(inner);
      document.body.appendChild(helpTooltip);
    }

    function positionHelpTooltip(btn) {
      if (!btn || !helpTooltip) return;
      const body = helpTooltip.querySelector(".card-help-tooltip-body");
      if (body) body.textContent = btn.dataset.help || "";
      helpTooltip.hidden = false;

      const margin = 8;
      const vw = window.innerWidth || 320;
      const vh = window.innerHeight || 480;
      const maxW = Math.min(320, vw - 2 * margin);
      helpTooltip.style.maxWidth = maxW + "px";
      /* Reset before measuring so previous run's position doesn't bias
       * the layout pass. */
      helpTooltip.style.left = "0px";
      helpTooltip.style.top = "0px";
      helpTooltip.style.right = "auto";

      const tw = helpTooltip.offsetWidth;
      const th = helpTooltip.offsetHeight;
      const r = btn.getBoundingClientRect();

      /* Horizontal placement: prefer right-aligned with button, fall
       * back to left-aligned, then center. Always staying margin px
       * away from each edge. */
      let left;
      const rightAligned = r.right - tw;
      const leftAligned = r.left;
      if (rightAligned >= margin && rightAligned + tw <= vw - margin) {
        left = rightAligned;
      } else if (leftAligned >= margin && leftAligned + tw <= vw - margin) {
        left = leftAligned;
      } else {
        left = Math.max(margin, Math.min(vw - tw - margin, (vw - tw) / 2));
      }

      /* Vertical placement: below by default, above if it would clip. */
      let top = r.bottom + 8;
      let placement = "below";
      if (top + th > vh - margin) {
        top = r.top - th - 8;
        placement = "above";
        if (top < margin) {
          /* Force below; let the user scroll if needed. */
          top = Math.min(r.bottom + 8, vh - th - margin);
          placement = "below";
        }
      }

      helpTooltip.style.left = left + "px";
      helpTooltip.style.top = top + "px";
      helpTooltip.dataset.placement = placement;

      /* Slide the pointer to the horizontal middle of the button. */
      const pointer = helpTooltip.querySelector(".card-help-tooltip-pointer");
      if (pointer) {
        const buttonCenterX = r.left + r.width / 2;
        const localX = buttonCenterX - left;
        const clamped = Math.max(10, Math.min(tw - 10, localX));
        pointer.style.left = clamped + "px";
      }
    }

    function hideHelpTooltip() {
      if (helpTooltip) helpTooltip.hidden = true;
      document.querySelectorAll(".card-help.help-open").forEach((b) => b.classList.remove("help-open"));
    }

    /* Hover (desktop): show on mouseenter, hide on mouseleave. We bind
     * via event delegation on body so dynamically-rendered buttons work. */
    document.body.addEventListener("mouseover", (e) => {
      const btn = e.target.closest && e.target.closest(".card-help");
      if (!btn) return;
      positionHelpTooltip(btn);
    });
    document.body.addEventListener("mouseout", (e) => {
      const btn = e.target.closest && e.target.closest(".card-help");
      if (!btn) return;
      /* Don't hide if the user is keyboard-focused on the button OR
       * if any button is in the click-toggled "help-open" state. */
      if (document.activeElement === btn) return;
      if (document.querySelector(".card-help.help-open")) return;
      hideHelpTooltip();
    });

    /* Keyboard focus: same treatment for accessibility. */
    document.body.addEventListener("focusin", (e) => {
      const btn = e.target.closest && e.target.closest(".card-help");
      if (btn) positionHelpTooltip(btn);
    });
    document.body.addEventListener("focusout", (e) => {
      const btn = e.target.closest && e.target.closest(".card-help");
      if (!btn) return;
      if (document.querySelector(".card-help.help-open")) return;
      hideHelpTooltip();
    });

    /* Click toggles a sticky-open state for mobile (no hover). */
    document.body.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest(".card-help");
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const wasOpen = btn.classList.contains("help-open");
        document.querySelectorAll(".card-help.help-open").forEach((b) => b.classList.remove("help-open"));
        if (wasOpen) {
          hideHelpTooltip();
        } else {
          btn.classList.add("help-open");
          positionHelpTooltip(btn);
        }
        return;
      }
      /* Click anywhere else dismisses any open help. */
      hideHelpTooltip();
    });

    /* Escape closes any open help popover. */
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideHelpTooltip();
    });

    /* Reposition on scroll/resize so the popover keeps tracking the
     * button (or hides if the button moves out of view). */
    function repositionOpenHelp() {
      const btn = document.querySelector(".card-help.help-open");
      if (!btn) return hideHelpTooltip();
      const r = btn.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) {
        hideHelpTooltip();
        return;
      }
      positionHelpTooltip(btn);
    }
    window.addEventListener("scroll", repositionOpenHelp, { passive: true });
    window.addEventListener("resize", repositionOpenHelp);

    /* `data-collapsed-on-mobile` cards start collapsed only on phones
     * (≤ 720px). On desktop they stay expanded by default. The viewport
     * is checked once at init; we don't reactively re-collapse on resize
     * because that would yank the page out from under a user mid-scroll. */
    const isMobileViewport = (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches) || (window.innerWidth || 0) <= 720;
    document.querySelectorAll("[data-collapsible]").forEach((card) => {
      if (card.hasAttribute("data-collapsed-default")) card.classList.add("collapsed");
      if (isMobileViewport && card.hasAttribute("data-collapsed-on-mobile")) card.classList.add("collapsed");
      const header = card.querySelector(".card-header");
      if (!header) return;
      header.classList.add("collapsible-toggle");
      header.setAttribute("role", "button");
      header.setAttribute("tabindex", "0");
      header.setAttribute("aria-expanded", card.classList.contains("collapsed") ? "false" : "true");
      const chevron = document.createElement("span");
      chevron.className = "card-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "⌃";
      header.appendChild(chevron);
      function toggle() {
        const willCollapse = !card.classList.contains("collapsed");
        card.classList.toggle("collapsed", willCollapse);
        header.setAttribute("aria-expanded", willCollapse ? "false" : "true");
      }
      header.addEventListener("click", (e) => {
        /* Don't toggle when the user clicked an internal link / button. */
        if (e.target.closest("button, a, input, select, textarea, label")) return;
        toggle();
      });
      header.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });

    /* Discovery strictness toggle. Filtering is a pure function of the
     * already-scored list, so the switch re-derives the two sections
     * from the stashed run instead of waiting for the next search — the
     * previous build only applied it on the following run, which read
     * as the toggle doing nothing. */
    document.querySelectorAll("#discover-card .discover-mode button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = btn.dataset.strict === "1";
        if (s === state.discoverStrict) return;
        state.discoverStrict = s;
        document.querySelectorAll("#discover-card .discover-mode button").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", b === btn ? "true" : "false");
        });
        if (state.lastDiscoverResult) {
          state.lastDiscoverResult = Discovery.refilter(state.lastDiscoverResult, s);
          state.recommend.discover.new.page = 0;
          state.recommend.discover.already.page = 0;
          rerenderDiscovery();
        }
      });
    });

    /* Submit handler is wrapped in try/catch and renders the campaign list
     * immediately after add, *before* any await, so a slow Reddit fetch
     * cannot leave the user staring at a frozen form. We also bind a click
     * handler on the Save button as a belt-and-suspenders fallback for any
     * iOS Safari edge case where form submit doesn't fire. */
    async function handleCampaignSave(e) {
      if (e && e.preventDefault) e.preventDefault();
      const saveBtnEl = document.querySelector("#campaign-form button[type=submit]");
      try {
        const name = (document.getElementById("campaign-name").value || "").trim();
        if (!name) { Util.toast("Campaign needs a name", "error"); return; }
        const goalScore = document.getElementById("campaign-goal-score").value;
        const goalComments = document.getElementById("campaign-goal-comments").value;
        const rawIds = document.getElementById("campaign-post-ids").value;

        /* parsePostRefs splits the input into clean IDs and Reddit
         * mobile-share URLs (/r/<sub>/s/<token>). The shares need an
         * async redirect-following round-trip to extract the real ID. */
        const refs = Util.parsePostRefs(rawIds);
        let allIds = refs.ids.slice();
        let resolveFailed = [];

        if (refs.shares.length) {
          /* Visible progress while we resolve. */
          if (saveBtnEl) {
            saveBtnEl.disabled = true;
            saveBtnEl.dataset.originalText = saveBtnEl.textContent;
            saveBtnEl.textContent = `Resolving ${refs.shares.length} share URL${refs.shares.length === 1 ? "" : "s"}…`;
          }
          Util.setStatus(`Resolving ${refs.shares.length} share URL${refs.shares.length === 1 ? "" : "s"} via redirects…`, "");
          console.log(`[handleCampaignSave] resolving ${refs.shares.length} share URLs`);

          const urls = refs.shares.map((s) => s.url);
          const { resolved, failed } = await Reddit.resolveShareUrls(urls);
          for (const u of urls) {
            if (resolved[u]) allIds.push(resolved[u]);
          }
          resolveFailed = failed;
          allIds = Util.uniqBy(allIds, (x) => x);

          if (saveBtnEl) {
            saveBtnEl.disabled = false;
            if (saveBtnEl.dataset.originalText) saveBtnEl.textContent = saveBtnEl.dataset.originalText;
          }
          console.log(`[handleCampaignSave] resolved ${Object.keys(resolved).length}/${urls.length} share URLs; ${failed.length} failed`);
        }

        if (!allIds.length) {
          Util.toast(refs.shares.length
            ? "All share URLs failed to resolve. Check the URLs or try a different Data source."
            : "No valid post IDs found in the input.", "error");
          Util.setStatus("Save aborted — no valid IDs.", "err");
          return;
        }

        const c = Campaigns.add({ name, goalScore, goalComments, postIds: allIds });

        if (resolveFailed.length) {
          Util.toast(`Saved "${c.name}" with ${allIds.length} ID${allIds.length === 1 ? "" : "s"} (${resolveFailed.length} share URL${resolveFailed.length === 1 ? "" : "s"} failed to resolve)`, "error");
        } else if (Campaigns.persistErrorMessage()) {
          Util.toast(`Saved in this tab only — browser storage is unavailable (${Campaigns.persistErrorMessage()}).`, "error");
        } else {
          Util.toast(`Saved "${c.name}" (${c.postIds.length} post${c.postIds.length === 1 ? "" : "s"})`, "ok");
        }
        Util.setStatus(`Saved "${c.name}" — ${c.postIds.length} ID${c.postIds.length === 1 ? "" : "s"}`, "ok");

        document.getElementById("campaign-form").reset();
        const ppEl = document.getElementById("campaign-post-ids-preview");
        if (ppEl) { ppEl.hidden = true; ppEl.innerHTML = ""; }

        Router.invalidate(["campaigns"]);
        populateCampaignSelectors();

        refreshAllCampaignSummaries().catch((err) => {
          console.warn("refreshAllCampaignSummaries failed:", err);
        });

        openCampaign(c);
      } catch (err) {
        console.error("Couldn't save campaign:", err);
        Util.toast(`Couldn't save campaign: ${(err && err.message) || err}`, "error");
      } finally {
        if (saveBtnEl) {
          saveBtnEl.disabled = false;
          if (saveBtnEl.dataset.originalText) {
            saveBtnEl.textContent = saveBtnEl.dataset.originalText;
            delete saveBtnEl.dataset.originalText;
          }
        }
      }
    }

    const campaignForm = document.getElementById("campaign-form");
    if (campaignForm) campaignForm.addEventListener("submit", handleCampaignSave);
    const saveBtn = campaignForm && campaignForm.querySelector('button[type="submit"]');
    if (saveBtn) {
      saveBtn.addEventListener("click", (e) => {
        /* If the form is already going to submit, this no-ops; if for some
         * reason it isn't (broken form association on iOS), fire the same
         * handler from the click. */
        if (campaignForm && typeof campaignForm.requestSubmit === "function") {
          // requestSubmit honors HTML5 validation
        } else {
          handleCampaignSave(e);
        }
      });
    }

    const campaignRefreshBtn = document.getElementById("campaign-refresh");
    if (campaignRefreshBtn) campaignRefreshBtn.addEventListener("click", () => {
      const id = state.openCampaignId;
      if (!id) return;
      Reddit.clearCache();
      loadCampaign(id);
    });
    const campaignDeleteBtn = document.getElementById("campaign-delete");
    if (campaignDeleteBtn) campaignDeleteBtn.addEventListener("click", () => {
      const id = state.openCampaignId;
      if (!id) return;
      const c = Campaigns.get(id);
      if (!confirm(`Delete "${c ? c.name : "this campaign"}"? Stored locally only.`)) return;
      Campaigns.remove(id);
      state.openCampaignId = null;
      state.campaignAgg = null;
      refreshAllCampaignSummaries();
      Router.go("campaigns");
    });
    const campaignComposeBtn = document.getElementById("campaign-compose");
    if (campaignComposeBtn) campaignComposeBtn.addEventListener("click", () => {
      if (state.openCampaignId) openComposer(state.openCampaignId);
    });

    /* Cross-posts card delegated handlers:
     *  - toggle-crosspost-posts          -> reveal/hide per-post list
     *  - make-campaign-from-crosspost    -> show inline goals form
     *  - cancel-make-campaign            -> dismiss the inline form
     *  - submit on the form              -> save with goals, switch tabs
     * Each row carries data-cp-index pointing into state.crossPosts so
     * we can resolve back to the original group regardless of filters
     * or pagination. */
    const crosspostsEl = document.getElementById("crossposts");
    if (crosspostsEl) {
      function getRowGroup(rowEl) {
        if (!rowEl) return null;
        const idx = parseInt(rowEl.dataset.cpIndex || "-1", 10);
        return (state.crossPosts && state.crossPosts[idx]) || null;
      }

      crosspostsEl.addEventListener("click", (e) => {
        /* 1. Show / hide the per-post list for a group. */
        const toggleBtn = e.target.closest && e.target.closest('[data-action="toggle-crosspost-posts"]');
        if (toggleBtn) {
          e.preventDefault();
          const row = toggleBtn.closest(".crosspost-row");
          if (!row) return;
          const isExpanded = row.classList.toggle("expanded");
          toggleBtn.setAttribute("aria-expanded", isExpanded ? "true" : "false");
          const list = row.querySelector(".crosspost-posts");
          if (list) list.hidden = !isExpanded;
          return;
        }

        /* 1b. Inner "Show all N" / "Show top 5 only" toggle inside an
         *     already-expanded group. Reveals/hides the overflow rows
         *     so a YouTube link with 40+ cross-posts doesn't unfurl
         *     into a 40-card scroll-fest the moment the user opens it. */
        const overflowBtn = e.target.closest && e.target.closest('[data-action="toggle-crosspost-overflow"]');
        if (overflowBtn) {
          e.preventDefault();
          const row = overflowBtn.closest(".crosspost-row");
          if (!row) return;
          const overflow = row.querySelector(".crosspost-posts-overflow");
          if (!overflow) return;
          const willShow = overflow.hidden;
          overflow.hidden = !willShow;
          overflowBtn.setAttribute("aria-expanded", willShow ? "true" : "false");
          row.classList.toggle("overflow-shown", willShow);
          return;
        }

        /* 2. + Make campaign -> open inline goals form on this row. */
        const makeBtn = e.target.closest && e.target.closest('[data-action="make-campaign-from-crosspost"]');
        if (makeBtn) {
          e.preventDefault();
          const row = makeBtn.closest(".crosspost-row");
          const group = getRowGroup(row);
          if (!group) {
            Util.toast("Cross-post data not available — try refreshing.", "error");
            return;
          }
          /* Close any other open form so only one is in-flight at a time. */
          crosspostsEl.querySelectorAll(".crosspost-row.editing").forEach((r) => {
            r.classList.remove("editing");
            UI.dismissCrossPostMakeCampaignForm(r);
          });
          row.classList.add("editing");
          UI.renderCrossPostMakeCampaignForm(row, group);
          return;
        }

        /* 3. Cancel button inside the form. */
        const cancelBtn = e.target.closest && e.target.closest('[data-action="cancel-make-campaign"]');
        if (cancelBtn) {
          e.preventDefault();
          const row = cancelBtn.closest(".crosspost-row");
          if (!row) return;
          row.classList.remove("editing");
          UI.dismissCrossPostMakeCampaignForm(row);
          return;
        }
      });

      /* Form submit (delegated). Read name + goals, save, switch tabs. */
      crosspostsEl.addEventListener("submit", (e) => {
        const form = e.target.closest && e.target.closest(".crosspost-make-form");
        if (!form) return;
        e.preventDefault();
        const row = form.closest(".crosspost-row");
        const group = getRowGroup(row);
        if (!group) {
          Util.toast("Cross-post data not available — try refreshing.", "error");
          return;
        }
        const nameInput = form.querySelector('input[data-field="name"]');
        const scoreInput = form.querySelector('input[data-field="goalScore"]');
        const commentsInput = form.querySelector('input[data-field="goalComments"]');
        const name = (nameInput && nameInput.value || "").trim() || (() => {
          const titleSrc = group.kind === "url" ? group.key : (group.posts[0] && group.posts[0].title) || "Cross-post";
          return `Cross-post: ${String(titleSrc).slice(0, 60).trim()}`;
        })();
        const goalScore = scoreInput ? Number(scoreInput.value) || 0 : 0;
        const goalComments = commentsInput ? Number(commentsInput.value) || 0 : 0;
        const postIds = group.posts.map((p) => p.id).filter(Boolean);

        try {
          const c = Campaigns.add({ name, goalScore, goalComments, postIds });
          if (Campaigns.persistErrorMessage()) {
            Util.toast(`Saved in this tab only — browser storage is unavailable (${Campaigns.persistErrorMessage()}).`, "error");
          } else {
            const goalBits = [];
            if (goalScore) goalBits.push(`${Util.fmtNum(goalScore)} pts goal`);
            if (goalComments) goalBits.push(`${Util.fmtNum(goalComments)} comments goal`);
            const goalSuffix = goalBits.length ? ` (${goalBits.join(" · ")})` : "";
            Util.toast(`Created "${name}" — ${postIds.length} post${postIds.length === 1 ? "" : "s"} from ${group.subs.length} subs${goalSuffix}`, "ok");
          }
          row.classList.remove("editing");
          UI.dismissCrossPostMakeCampaignForm(row);
          /* Visual confirmation: turn the original action button into
           * "Created ✓" so the user sees it stuck on this row. */
          const origBtn = row.querySelector('[data-action="make-campaign-from-crosspost"]');
          if (origBtn) {
            origBtn.disabled = true;
            origBtn.textContent = "Created ✓";
          }
          populateCampaignSelectors();
          refreshAllCampaignSummaries().catch((err) => console.warn("[crosspost->campaign] summary refresh failed:", err && err.message));
          openCampaign(c);
          console.log(`[crosspost->campaign] "${name}" goals=(${goalScore}, ${goalComments}) ids=${postIds.length} subs=${group.subs.length}`);
        } catch (err) {
          console.error("[crosspost->campaign] failed:", err);
          Util.toast(`Couldn't create campaign: ${(err && err.message) || err}`, "error");
        }
      });
    }

    /* Posts-table delegated handlers for "+ Campaign" inline action.
     *
     * Flow:
     *   1. user taps "+ Campaign" on a post row
     *   2. inline form drops in below the row (name + optional goals)
     *   3. on submit:
     *      - create a campaign with this single post ID
     *      - switch to the Campaigns tab and open the new campaign
     *      - auto-trigger Discover so recommended subreddits + their
     *        "Cross-post here" links + paste-back trackers populate
     *        without an extra click.
     */
    /* Delegated from document rather than from #posts-tbody, because
     * the very same form is now also opened from the post detail panel,
     * which lives outside the table. */
    document.addEventListener("click", (e) => {
      const makeBtn = e.target.closest && e.target.closest('[data-action="make-campaign-from-post"]');
      if (makeBtn) {
        e.preventDefault();
        e.stopPropagation();
        const tr = makeBtn.closest("tr");
        const postId = makeBtn.dataset.postId;
        const post = (state.posts || []).find((p) => p.id === postId);
        if (!post || !tr) {
          Util.toast("Post data not available — try refreshing.", "error");
          return;
        }
        /* Close any other open form so only one is in-flight at a time. */
        document.querySelectorAll(".post-make-form-row").forEach((r) => {
          const prev = r.previousElementSibling;
          if (prev && prev !== tr) UI.dismissPostMakeCampaignForm(prev);
        });
        UI.renderPostMakeCampaignForm(tr, post);
        primeRelatedPreview(tr.nextElementSibling, post);
        return;
      }

      const cancelBtn = e.target.closest && e.target.closest('[data-action="cancel-make-campaign-from-post"]');
      if (cancelBtn) {
        e.preventDefault();
        e.stopPropagation();
        const formRow = cancelBtn.closest(".post-make-form-row");
        if (formRow) {
          const tr = formRow.previousElementSibling;
          if (tr) UI.dismissPostMakeCampaignForm(tr);
          return;
        }
        const host = Dom.byId("post-related-form");
        if (host) { host.hidden = true; host.innerHTML = ""; }
      }
    });

    document.addEventListener("submit", async (e) => {
      const form = e.target.closest && e.target.closest(".post-make-form");
      if (!form) return;
      e.preventDefault();
      e.stopPropagation();
      await handleMakeCampaignFromPost(form);
    });

    /* Related-communities panel inside the post detail card. */
    Dom.delegate(document, "click", '[data-action="load-related-subs"]', (e, btn) => {
      const picked = checkedRelatedSubs(Dom.byId("post-related-body"));
      if (!picked.length) {
        Util.toast("Check at least one community first.", "error");
        return;
      }
      const added = AppState.addSubs(picked);
      renderChips();
      btn.disabled = true;
      btn.textContent = added.length ? `Loading ${added.length}…` : "Already loaded";
      if (!added.length) return;
      Util.toast(`Added ${added.length} communit${added.length === 1 ? "y" : "ies"} — pulling their posts.`, "ok");
      refreshData().catch((err) => console.warn("[post-related] load failed:", err && err.message));
    });

    Dom.delegate(document, "click", '[data-action="load-sphere-from-post"]', (e, btn) => {
      const key = btn.dataset.sphere;
      const subs = Seeds.expand([key]);
      if (!subs.length) return;
      const added = AppState.addSubs(subs);
      renderChips();
      Util.toast(added.length
        ? `Added ${added.length} of ${subs.length} communities from ${Seeds.labelOf(String(key).replace(/^(state|demo):/, ""))}.`
        : `Every community in that sphere is already loaded.`, "ok");
      if (added.length) refreshData().catch((err) => console.warn("[post-related] sphere load failed:", err && err.message));
    });

    Dom.delegate(document, "click", '[data-action="campaign-from-detail"]', (e, btn) => {
      const post = (state.posts || []).find((p) => p.id === btn.dataset.postId);
      if (!post) {
        Util.toast("Post data not available — try refreshing.", "error");
        return;
      }
      const host = Dom.byId("post-related-form");
      if (!host) return;
      UI.renderPostMakeCampaignInline(host, post);
      host.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    /* Drop the cached sphere match into the form so the user can see
     * (and deselect) the communities before committing. */
    function primeRelatedPreview(container, post) {
      const host = container && container.querySelector('[data-role="pmf-related"]');
      if (!host) return;
      const cached = state.postRelated.get(post.id);
      if (cached) {
        UI.renderPostRelated(host, cached, { compact: true, actions: false, limit: 6 });
        return;
      }
      function paint(result) {
        if (!host.isConnected) return;
        UI.renderPostRelated(host, result, { compact: true, actions: false, limit: 6 });
      }

      UI.renderPostRelated(host, null);
      relatedForPost(post, { onPartial: paint })
        .then(paint)
        .catch((err) => {
          if (host.isConnected) host.innerHTML = `<p class="post-related-status">Couldn't match communities: ${Util.escapeHtml(err.message || String(err))}</p>`;
        });
    }

    async function handleMakeCampaignFromPost(form) {
      const formRow = form.closest(".post-make-form-row");
      const tr = formRow && formRow.previousElementSibling;
      const postId = form.dataset.postId;
      const post = (state.posts || []).find((p) => p.id === postId);
      if (!post) {
        Util.toast("Post data not available — try refreshing.", "error");
        return;
      }
      const nameInput = form.querySelector('input[data-field="name"]');
      const scoreInput = form.querySelector('input[data-field="goalScore"]');
      const commentsInput = form.querySelector('input[data-field="goalComments"]');
      const fallbackName = `From r/${post.subreddit}: ${(post.title || "").slice(0, 60).trim()}`;
      const name = (nameInput && nameInput.value || "").trim() || fallbackName;
      const goalScore = scoreInput ? Number(scoreInput.value) || 0 : 0;
      const goalComments = commentsInput ? Number(commentsInput.value) || 0 : 0;

      const submitBtn = form.querySelector('[data-action="confirm-make-campaign-from-post"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.dataset.originalText = submitBtn.textContent;
        submitBtn.textContent = "Saving…";
      }

      try {
        const c = Campaigns.add({ name, goalScore, goalComments, postIds: [post.id] });
        if (Campaigns.persistErrorMessage()) {
          Util.toast(`Saved in this tab only — browser storage is unavailable (${Campaigns.persistErrorMessage()}).`, "error");
        } else {
          Util.toast(`Created "${name}" — finding recommended subreddits…`, "ok");
        }

        /* Loading the matched communities is what makes the rest of the
         * app useful for this post: once their posts are in, each one
         * gets its own posting-time panel and its own benchmark on the
         * campaign's subreddit cards. */
        const wantsRelated = form.querySelector('input[data-field="loadRelated"]');
        if (!wantsRelated || wantsRelated.checked) {
          /* Opened from the detail panel, the form has no list of its
           * own — it inherits whatever is ticked in the panel above. */
          const picked = form.closest("#post-related-form")
            ? checkedRelatedSubs(Dom.byId("post-related-body"))
            : checkedRelatedSubs(form);
          if (picked.length) {
            const added = AppState.addSubs(picked);
            renderChips();
            if (added.length) {
              Util.toast(`Loading ${added.length} matched communit${added.length === 1 ? "y" : "ies"} alongside the campaign…`, "ok");
              refreshData().catch((err) => console.warn("[post->campaign] sub load failed:", err && err.message));
            }
          }
        }

        /* Mark the original action button as Created ✓ for visible
         * feedback even when the user scrolls back to the posts tab. */
        if (tr) {
          const origBtn = tr.querySelector('[data-action="make-campaign-from-post"]');
          if (origBtn) {
            origBtn.disabled = true;
            origBtn.textContent = "Created ✓";
          }
          UI.dismissPostMakeCampaignForm(tr);
        }

        populateCampaignSelectors();
        refreshAllCampaignSummaries().catch((err) => console.warn("[post->campaign] summary refresh failed:", err && err.message));
        openCampaign(c);
        await loadCampaign(c.id);

        /* Auto-trigger Discover. The discover-campaign select must be
         * set to this campaign first; if either piece isn't available
         * (e.g. the user navigated away mid-flight) we just skip with
         * a console warning rather than throwing. */
        const sel = document.getElementById("discover-campaign");
        if (sel) sel.value = c.id;
        if (typeof _runDiscover === "function") {
          /* Scroll the discover panel into view so the user can see
           * the recommendations populating. */
          const discoverCard = document.getElementById("discover-card");
          if (discoverCard && typeof discoverCard.scrollIntoView === "function") {
            try { discoverCard.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_) {}
          }
          try { await _runDiscover(); }
          catch (err) { console.warn("[post->campaign] auto-discover failed:", err && err.message); }
        }
        console.log(`[post->campaign] "${name}" goals=(${goalScore}, ${goalComments}) post=${post.id} sub=${post.subreddit}`);
      } catch (err) {
        console.error("[post->campaign] failed:", err);
        Util.toast(`Couldn't create campaign: ${(err && err.message) || err}`, "error");
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = submitBtn.dataset.originalText || "Save & find subreddits";
        }
      }
    }

    /* Add-posts form, per-row remove, digest and goals editor inside the
     * campaign workspace. Delegated from document rather than from the
     * section element, because every one of these is re-rendered from
     * scratch whenever the campaign's data changes. */
    {
      /* Live paste preview under the add-posts textarea. */
      document.addEventListener("input", (e) => {
        const ta = e.target.closest && e.target.closest('[data-role="add-posts-textarea"]');
        if (!ta) return;
        const form = ta.closest(".add-posts-form");
        const prev = form && form.querySelector('[data-role="add-posts-preview"]');
        /* Once the user starts typing again, clear any stale
         * "Couldn't add" / "Already in this campaign" message so
         * the form doesn't display contradictory state. */
        const statusEl = form && form.querySelector('[data-role="add-posts-status"]');
        if (statusEl && (statusEl.classList.contains("error") || statusEl.classList.contains("warn"))) {
          statusEl.hidden = true; statusEl.innerHTML = ""; statusEl.className = "add-posts-status";
        }
        if (!prev) return;
        const refs = Util.parsePostRefs(ta.value);
        if (!refs.ids.length && !refs.shares.length) {
          prev.hidden = true; prev.innerHTML = ""; return;
        }
        prev.hidden = false;
        const idChips = refs.ids.slice(0, 60).map((id) =>
          `<span class="kw"><code>${Util.escapeHtml(id)}</code></span>`
        ).join("");
        const shareChips = refs.shares.slice(0, 30).map((sh) =>
          `<span class="kw share" title="${Util.escapeHtml(sh.url)} — will be resolved on Add"><code>r/${Util.escapeHtml(sh.sub)}/s/${Util.escapeHtml(sh.token)}</code></span>`
        ).join("");
        const head = [];
        if (refs.ids.length) head.push(`<strong>${refs.ids.length}</strong> ID${refs.ids.length === 1 ? "" : "s"} ready`);
        if (refs.shares.length) head.push(`<span style="color:var(--warn)">${refs.shares.length} share URL${refs.shares.length === 1 ? "" : "s"} — will resolve on Add</span>`);
        prev.innerHTML = `<div class="meta">${head.join(" · ")}</div>${idChips}${shareChips}`;
      });

      document.addEventListener("paste", (e) => {
        const ta = e.target.closest && e.target.closest('[data-role="add-posts-textarea"]');
        if (!ta) return;
        setTimeout(() => ta.dispatchEvent(new Event("input", { bubbles: true })), 0);
      });

      /* Cmd/Ctrl+Enter inside the add-posts textarea triggers the
       * Add button. This lets a user who pastes a URL hit the
       * keyboard shortcut they expect (matching most chat / form
       * UIs) instead of fishing for a small button — and combined
       * with the inline preview chips above, makes it visually
       * obvious that the IDs are about to be added. */
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
        const ta = e.target.closest && e.target.closest('[data-role="add-posts-textarea"]');
        if (!ta) return;
        const form = ta.closest(".add-posts-form");
        const addBtn = form && form.querySelector('[data-action="add-posts"]');
        if (addBtn) {
          e.preventDefault();
          addBtn.click();
        }
      });

      /* Click delegation: Add posts / Remove from campaign / Copy digest /
       * Edit goals (open form, save, cancel). */
      document.addEventListener("click", async (e) => {
        const addBtn = e.target.closest && e.target.closest('[data-action="add-posts"]');
        const pasteBtn = e.target.closest && e.target.closest('[data-action="add-posts-paste"]');
        const rmBtn  = e.target.closest && e.target.closest('[data-action="remove-post"]');
        const digestBtn = e.target.closest && e.target.closest('[data-action="copy-campaign-digest"]');

        if (addBtn) {
          e.preventDefault();
          await handleAddPostsToOpenCampaign(addBtn);
          return;
        }
        if (pasteBtn) {
          e.preventDefault();
          /* "📋 Paste" — explicit-gesture wrapper that reads the
           * clipboard, fills the textarea, and immediately fires the
           * Add flow if the content parses as Reddit refs. Same UX
           * as the cross-post candidate tracker (PR #61). */
          const form = pasteBtn.closest(".add-posts-form");
          const ta = form && form.querySelector('[data-role="add-posts-textarea"]');
          if (!ta) return;
          try {
            if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
              Util.toast("Clipboard not available — paste manually.", "error");
              try { ta.focus(); } catch (_) {}
              return;
            }
            const text = await navigator.clipboard.readText();
            if (!text || !text.trim()) {
              Util.toast("Clipboard is empty.", "error");
              try { ta.focus(); } catch (_) {}
              return;
            }
            const refs = Util.parsePostRefs(text);
            if (!refs.ids.length && !refs.shares.length) {
              Util.toast("Clipboard didn't contain a Reddit post URL/ID.", "error");
              ta.value = text;
              try { ta.focus(); } catch (_) {}
              return;
            }
            ta.value = text.trim();
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            /* Auto-fire the Add flow — saves the user a tap. */
            const realAddBtn = form.querySelector('[data-action="add-posts"]');
            if (realAddBtn) realAddBtn.click();
          } catch (err) {
            Util.toast("Couldn't read clipboard: " + ((err && err.message) || err), "error");
            try { ta.focus(); } catch (_) {}
          }
          return;
        }
        if (rmBtn) {
          e.preventDefault();
          handleRemovePostFromOpenCampaign(rmBtn);
          return;
        }
        if (digestBtn) {
          e.preventDefault();
          /* Build digest from the same data the detail panel was just
           * rendered with — pull from state.campaignSummaries which
           * holds the latest aggregated payload + deep analysis. */
          const id = state.openCampaignId;
          const camp = id && Campaigns.get(id);
          const summary = id && state.campaignSummaries && state.campaignSummaries[id];
          if (!camp || !summary) {
            Util.toast("Open a campaign first.", "error");
            return;
          }
          const text = buildCampaignDigest(camp, summary, summary.deep);
          const ok = await copyToClipboard(text);
          if (ok) {
            Util.toast(`Digest for "${camp.name}" copied — paste into Signal/Slack/etc.`, "ok");
          } else {
            Util.toast("Could not access clipboard. Digest in console.", "error");
            console.log("[digest]\n" + text);
          }
          return;
        }
      });

      /* Submit handler for the inline goals editor. */
      document.addEventListener("submit", async (e) => {
        const form = e.target.closest && e.target.closest(".goals-edit-form");
        if (!form) return;
        e.preventDefault();
        const id = form.dataset.campaignId || state.openCampaignId;
        if (!id) { Util.toast("No active campaign.", "error"); return; }
        const camp = Campaigns.get(id);
        if (!camp) { Util.toast("Campaign not found.", "error"); return; }
        const scoreInput = form.querySelector('input[data-field="goalScore"]');
        const commentsInput = form.querySelector('input[data-field="goalComments"]');
        const goalScore = scoreInput ? Math.max(0, Number(scoreInput.value) || 0) : 0;
        const goalComments = commentsInput ? Math.max(0, Number(commentsInput.value) || 0) : 0;
        try {
          Campaigns.update(id, { goalScore, goalComments });
          Util.toast(`Goals updated for "${camp.name}".`, "ok");
          /* Re-open the campaign so the detail re-renders with the
           * new goals and progress bars recalculate. */
          await loadCampaign(id);
        } catch (err) {
          console.error("[goals-edit] failed:", err);
          Util.toast(`Couldn't save goals: ${(err && err.message) || err}`, "error");
        }
      });
    }

    /* Watch toggle button (PR 6). Lives in #watch-toggle-slot at the
     * top of the campaign detail card. Click toggles auto-refresh. */
    const workspaceEl = document.getElementById("view-campaign");
    if (workspaceEl) {
      workspaceEl.addEventListener("click", (e) => {
        const btn = e.target.closest && e.target.closest('[data-action="toggle-watch"]');
        if (!btn) return;
        e.preventDefault();
        if (state.watchedCampaignId === state.openCampaignId && watchTimer) {
          stopWatch();
        } else if (state.openCampaignId) {
          startWatch(state.openCampaignId);
        }
      });
    }

    /* Stamp a small status block onto the add-posts form. Stays
     * visible after the toast disappears so the user has an unambiguous
     * confirmation that their paste landed (or didn't). The previous
     * implementation only fired a Util.toast which could be missed
     * if the user looked away during the network round-trip. */
    function setAddPostsStatus(form, html, kind) {
      if (!form) return;
      let el = form.querySelector('[data-role="add-posts-status"]');
      if (!el) {
        el = document.createElement("div");
        el.className = "add-posts-status";
        el.setAttribute("data-role", "add-posts-status");
        form.appendChild(el);
      }
      el.className = "add-posts-status " + (kind || "");
      el.innerHTML = html;
      if (!html) el.hidden = true; else el.hidden = false;
      /* Auto-hide ok states after 6s; keep errors visible until the
       * user types in the textarea (cleared from the input handler). */
      if (kind === "ok" && el._timer) clearTimeout(el._timer);
      if (kind === "ok") {
        el._timer = setTimeout(() => {
          if (el && el.classList.contains("ok")) { el.hidden = true; el.innerHTML = ""; }
        }, 6000);
      }
    }

    async function handleAddPostsToOpenCampaign(btn) {
      const form = btn.closest(".add-posts-form");
      const ta = form && form.querySelector('[data-role="add-posts-textarea"]');
      const prev = form && form.querySelector('[data-role="add-posts-preview"]');
      if (!form || !ta) return;
      const campaignId = form.dataset.campaignId || state.openCampaignId;
      if (!campaignId) { Util.toast("No active campaign.", "error"); return; }

      try {
        const refs = Util.parsePostRefs(ta.value);
        let allIds = refs.ids.slice();
        let resolveFailed = [];

        if (!refs.ids.length && !refs.shares.length) {
          Util.toast("Paste a Reddit URL, share link, or post ID first.", "error");
          setAddPostsStatus(form, "Paste a Reddit URL, share link, or post ID, then tap Add.", "warn");
          return;
        }

        if (refs.shares.length) {
          btn.disabled = true;
          btn.dataset.originalText = btn.textContent;
          btn.textContent = `Resolving ${refs.shares.length} share URL${refs.shares.length === 1 ? "" : "s"}…`;
          const urls = refs.shares.map((sh) => sh.url);
          const { resolved, failed } = await Reddit.resolveShareUrls(urls);
          for (const u of urls) {
            if (resolved[u]) allIds.push(resolved[u]);
          }
          resolveFailed = failed;
          allIds = Util.uniqBy(allIds, (x) => x);
          console.log(`[addPostsToCampaign] resolved ${Object.keys(resolved).length}/${urls.length} share URLs; ${failed.length} failed`);
        }

        if (!allIds.length) {
          Util.toast(refs.shares.length
            ? "All share URLs failed to resolve. Try a different Data source."
            : "No valid post IDs found.", "error");
          return;
        }

        const result = Campaigns.addPostIds(campaignId, allIds);
        if (!result) { Util.toast("Campaign not found.", "error"); return; }

        const addedIds = (result.addedIds || []).slice();
        const addedChips = addedIds.length
          ? ` <span class="add-posts-status-chips">${addedIds.map((id) => `<code>${Util.escapeHtml(id)}</code>`).join(" ")}</span>`
          : "";

        if (resolveFailed.length) {
          Util.toast(`Added ${result.added} post${result.added === 1 ? "" : "s"} (${resolveFailed.length} share URL${resolveFailed.length === 1 ? "" : "s"} failed)`, "error");
          setAddPostsStatus(form, `<strong>Added ${result.added}</strong> · ${resolveFailed.length} share URL failed${addedChips}`, "warn");
        } else if (result.added === 0) {
          Util.toast("Those posts are already in the campaign.", "ok");
          setAddPostsStatus(form, `Already in this campaign — nothing to add.`, "warn");
        } else {
          Util.toast(`Added ${result.added} post${result.added === 1 ? "" : "s"} to "${result.campaign.name}".`, "ok");
          setAddPostsStatus(form, `<strong>✓ Added ${result.added} post${result.added === 1 ? "" : "s"}</strong> to <em>${Util.escapeHtml(result.campaign.name)}</em>${addedChips}`, "ok");
        }

        ta.value = "";
        if (prev) { prev.hidden = true; prev.innerHTML = ""; }

        /* Re-render the campaign detail with fresh aggregated data and
         * refresh the list-card on the side. */
        await openCampaign(result.campaign);
        refreshAllCampaignSummaries().catch(() => {});
      } catch (err) {
        console.error("[addPostsToCampaign] failed:", err);
        Util.toast(`Couldn't add posts: ${(err && err.message) || err}`, "error");
        setAddPostsStatus(form, `<strong>✗ Couldn't add:</strong> ${Util.escapeHtml((err && err.message) || String(err)).slice(0, 200)}`, "error");
      } finally {
        if (btn) {
          btn.disabled = false;
          if (btn.dataset.originalText) {
            btn.textContent = btn.dataset.originalText;
            delete btn.dataset.originalText;
          }
        }
      }
    }

    function handleRemovePostFromOpenCampaign(btn) {
      const id = btn.dataset.id;
      if (!id) return;
      const campaignId = state.openCampaignId;
      if (!campaignId) return;
      const result = Campaigns.removePostIds(campaignId, [id]);
      if (!result) return;
      Util.toast(`Removed post ${id}.`, "ok");
      /* Optimistically hide the row immediately for snappy feedback —
       * works for both resolved-post rows AND unresolved-ID chips. */
      const target = btn.closest(".campaign-post-row, .unresolved-chip");
      if (target) target.style.display = "none";
      /* Then re-render fully to update KPIs / progress bars / deep analysis. */
      loadCampaign(result.campaign.id).catch(() => {});
      refreshAllCampaignSummaries().catch(() => {});
    }


    /* Section rail: pill links that smooth-scroll to a section inside
     * the current view. */
    Dom.delegate(document, "click", ".section-rail a[data-jump]", (e, link) => {
      e.preventDefault();
      const key = link.dataset.jump;
      const target = document.getElementById(key) || document.querySelector(`[data-anchor="${key}"]`);
      if (!target) return;
      for (const sib of link.parentElement.children) sib.classList.toggle("active", sib === link);
      try { target.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_) { target.scrollIntoView(); }
      target.classList.add("just-jumped");
      setTimeout(() => target.classList.remove("just-jumped"), 900);
    });

    /* Cross-posts — search + sub filter + min-spread
     * chips + per-page. The list of cross-post groups can grow into
     * the hundreds on a busy dashboard, so all four controls feed
     * into renderCrossPostsView() (which calls filteredCrossPosts())
     * and skip the heavier rerenderAll() so they're snappy. */
    const xpSearch = document.getElementById("crossposts-search");
    if (xpSearch) {
      const debouncedXpSearch = Util.debounce(() => { renderCrossPostsView(); }, 200);
      xpSearch.addEventListener("input", (e) => {
        state.crossPostsSearchQuery = (e.target.value || "").trim();
        state.crossPostsPage = 0;
        debouncedXpSearch();
      });
    }
    const xpSubSel = document.getElementById("crossposts-sub-filter");
    if (xpSubSel) xpSubSel.addEventListener("change", (e) => {
      state.crossPostsSubFilter = e.target.value || "";
      state.crossPostsPage = 0;
      renderCrossPostsView();
    });
    const xpPageSizeSel = document.getElementById("crossposts-page-size");
    if (xpPageSizeSel) xpPageSizeSel.addEventListener("change", (e) => {
      state.crossPostsPageSize = e.target.value === "all" ? "all" : Number(e.target.value) || 10;
      state.crossPostsPage = 0;
      renderCrossPostsView();
    });

    /* Min-spread chips for cross-posts (radio-style group). Constraint
     * filter, distinct from the free-text search above. */
    document.querySelectorAll('.crossposts-controls .chip-group [data-min-spread]').forEach((chip) => {
      chip.addEventListener("click", () => {
        const v = Number(chip.dataset.minSpread || 0) || 0;
        if (state.crossPostsMinSpread === v) return;
        state.crossPostsMinSpread = v;
        document.querySelectorAll('.crossposts-controls .chip-group [data-min-spread]').forEach((c) => {
          const isOn = Number(c.dataset.minSpread || 0) === v;
          c.classList.toggle("active", isOn);
          c.setAttribute("aria-checked", isOn ? "true" : "false");
        });
        state.crossPostsPage = 0;
        renderCrossPostsView();
      });
    });

    /* Sphere picker dropdowns + chip removal. Populate options from
     * Seeds.* labels, persist user picks, render chips. */
    populateSphereDropdowns();
    renderActiveSpheres();
    ["sphere-add-issue", "sphere-add-state", "sphere-add-audience"].forEach((id) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.addEventListener("change", (e) => {
        const v = e.target.value;
        if (!v) return;
        addSphere(v);
        sel.value = "";
      });
    });
    const activeChips = document.getElementById("active-spheres");
    if (activeChips) {
      activeChips.addEventListener("click", (e) => {
        const x = e.target && e.target.closest && e.target.closest('[data-action="remove-sphere"]');
        if (!x) return;
        e.preventDefault();
        e.stopPropagation();
        removeSphere(x.dataset.sphereKey);
      });
    }
    /* Auto-detected spheres are already folded into the run that
     * produced them; pinning one carries it forward to every later run,
     * including ones whose campaign text no longer mentions the issue. */
    const sphereSuggestions = document.getElementById("sphere-suggestions");
    if (sphereSuggestions) {
      sphereSuggestions.addEventListener("click", (e) => {
        const chip = e.target && e.target.closest && e.target.closest('[data-action="pin-sphere"]');
        if (!chip) return;
        e.preventDefault();
        const key = chip.dataset.sphereKey;
        if (state.activeSpheres.includes(key)) removeSphere(key);
        else addSphere(key);
        renderSphereSuggestions(state.lastDiscoverResult);
      });
    }
    renderSphereSuggestions(null);

    /* ------ Discover similar subreddits ------ */
    const discoverBtn = document.getElementById("discover-run");
    const discoverSel = document.getElementById("discover-campaign");
    const discoverResults = document.getElementById("discover-results");
    const discoverStatus = document.getElementById("discover-status");

    function setDiscoverStatus(text, kind) {
      if (!discoverStatus) return;
      discoverStatus.hidden = !text;
      discoverStatus.className = "meta " + (kind || "");
      discoverStatus.textContent = text || "";
    }

    /* The panel is a thin shell over Discovery.run: pick the inputs out
     * of app state, forward progress to the bar, stash the result so the
     * strictness toggle and the pagers can repaint from it without
     * re-running a multi-second search. */
    async function runDiscover() {
      if (!discoverSel || !discoverSel.value) {
        setDiscoverStatus("Pick a campaign first.", "err");
        return;
      }
      const campaign = Campaigns.get(discoverSel.value);
      if (!campaign) { setDiscoverStatus("Campaign not found.", "err"); return; }

      const summary = state.campaignSummaries[campaign.id];
      if (!summary || !summary.posts || !summary.posts.length) {
        setDiscoverStatus(`"${campaign.name}" has no resolved posts yet. Open it and tap Refresh first.`, "err");
        if (discoverResults) discoverResults.innerHTML = "";
        return;
      }

      const profile = Analysis.campaignProfile(summary.posts, campaign);
      if (discoverBtn) { discoverBtn.disabled = true; discoverBtn.textContent = "Searching…"; }
      setDiscoverStatus(`Reading what "${campaign.name}" is about…`);
      if (discoverResults) {
        discoverResults.innerHTML = `<div class="empty"><div class="skeleton" style="margin-bottom:6px"></div><div class="skeleton" style="margin-bottom:6px;width:80%"></div><div class="skeleton" style="width:60%"></div></div>`;
      }

      const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
      try {
        const result = await Discovery.run({
          posts: summary.posts,
          profile: profile,
          spheres: state.activeSpheres,
          /* Subs the campaign already posted in, plus everything loaded
           * in the dashboard: still ranked, but shown separately as
           * confirmation rather than offered as something to add. */
          exclude: [].concat(profile.subreddits || [], Array.from(state.activeSubs)),
          strict: state.discoverStrict !== false,
          subProfiles: state.subProfiles || {},
          onProgress: (pct, message) => Util.setProgress(pct, message),
        });

        const bestCampaignPost = (summary.posts || [])
          .slice()
          .sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;

        state.lastDiscoverResult = result;
        state.lastDiscoverCtx = {
          campaign: campaign,
          bestCampaignPost: bestCampaignPost,
          campaignSubs: new Set((profile.subreddits || []).map((s) => String(s).toLowerCase())),
        };
        /* A fresh run is a new ranking, so start at the top of it rather
         * than stranding the user on page 5 of the previous campaign. */
        state.recommend.discover.new.page = 0;
        state.recommend.discover.already.page = 0;
        rerenderDiscovery();

        const dur = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
        const f = result.filtered || {};
        const spheres = (result.autoSpheres || []).map((s) => `${s.key}:${s.confidence}%`).join(" ") || "—";
        console.log(`[discover] ${campaign.name}: ${result.queries.length} queries · spheres ${spheres} · ${result.totalScanned} scored (${result.postsMined} subs mined from posts) → ${result.candidates.length} new + ${result.alreadyLoaded.length} already-loaded · dropped offtopic=${f.offtopic || 0} weak=${f.weak || 0} mega=${f.mega || 0} · ${dur}ms`);
        Util.hideProgress(`${result.candidates.length} new sub${result.candidates.length === 1 ? "" : "s"} · ${result.alreadyLoaded.length} already loaded`);
      } catch (err) {
        console.warn("[discover] failed:", err && err.message);
        setDiscoverStatus(`Discovery failed: ${(err && err.message) || err}`, "err");
        Util.hideProgress();
        if (discoverResults) discoverResults.innerHTML = "";
      } finally {
        if (discoverBtn) { discoverBtn.disabled = false; discoverBtn.textContent = "Find subreddits"; }
      }
    }

    if (discoverBtn) discoverBtn.addEventListener("click", runDiscover);
    /* Hoist runDiscover up to the IIFE scope so other handlers (e.g.
     * the new Posts-tab → Make Campaign flow) can call it without
     * having to fake-click the discover button. */
    _runDiscover = runDiscover;

    /* discover-results delegated handlers:
     *  - data-action="add"                 -> add candidate sub to dashboard
     *  - data-action="open-submit"         -> auto-expand the tracker
     *                                         <details> so the paste-back
     *                                         input is ready when the user
     *                                         comes back from Reddit
     *  - data-action="track-post-confirm"  -> resolve the pasted URL +
     *                                         add it to the open campaign
     *  - Enter key inside track-post-url   -> same as confirm */
    if (discoverResults) {
      discoverResults.addEventListener("click", async (e) => {
        const addBtn = e.target && e.target.closest && e.target.closest('[data-action="add"]');
        if (addBtn) {
          const name = addBtn.dataset.name;
          if (!name) return;
          const norm = Util.normalizeSubName(name);
          if (!state.knownSubs.includes(norm)) state.knownSubs.push(norm);
          state.activeSubs.add(norm);
          persist();
          renderChips();
          Util.toast(`Added r/${norm} — fetching…`, "ok");
          const row = addBtn.closest(".target-row");
          if (row) row.classList.add("already");
          addBtn.disabled = true;
          addBtn.textContent = "Added ✓";
          refreshData();
          return;
        }

        const openBtn = e.target && e.target.closest && e.target.closest('[data-action="open-submit"]');
        if (openBtn) {
          /* Don't preventDefault — the link must still open the
           * Reddit /submit page. We auto-expand the tracker AND focus
           * the URL-paste input so the user lands on a focused field
           * the moment they come back from the Reddit tab. */
          const card = openBtn.closest(".target-row");
          const tracker = card && card.querySelector(".cand-tracker");
          if (tracker) {
            tracker.open = true;
            const input = tracker.querySelector('[data-action="track-post-url"]');
            if (input) {
              /* Slight delay so the new-tab-opening handoff doesn't
               * steal focus back. iOS Safari is particularly fussy. */
              setTimeout(() => {
                try { input.focus(); } catch (_) {}
              }, 150);
            }
          }
          return;
        }

        const pasteBtn = e.target && e.target.closest && e.target.closest('[data-action="track-post-paste"]');
        if (pasteBtn) {
          e.preventDefault();
          await handleManualClipboardPaste(pasteBtn);
          return;
        }

        const trackBtn = e.target && e.target.closest && e.target.closest('[data-action="track-post-confirm"]');
        if (trackBtn) {
          e.preventDefault();
          await handleTrackPostFromCandidate(trackBtn);
          return;
        }
      });

      discoverResults.addEventListener("keydown", (e) => {
        const input = e.target && e.target.closest && e.target.closest('[data-action="track-post-url"]');
        if (!input || e.key !== "Enter") return;
        e.preventDefault();
        const tracker = input.closest(".cand-tracker");
        const btn = tracker && tracker.querySelector('[data-action="track-post-confirm"]');
        if (btn) btn.click();
      });

      /* AUTO-FILL ON FOCUS: when the URL input gains focus and is
       * empty, try reading the clipboard. If it contains a Reddit
       * reference, fill the input. (iOS Safari often blocks this
       * without a user gesture, so the focus event itself is our
       * gesture — even so, it sometimes returns a permission-denied
       * promise rejection. We just fall through silently.) */
      discoverResults.addEventListener("focusin", async (e) => {
        const input = e.target && e.target.closest && e.target.closest('[data-action="track-post-url"]');
        if (!input || input.value) return;
        await tryAutoFillFromClipboard(input);
      });

      /* AUTO-SUBMIT ON PASTE: when the user pastes into the input,
       * wait one tick for the value to update, validate via parsePostRefs,
       * and fire the confirm flow automatically — saving them an
       * "Add to campaign" tap. The standard Add button still works
       * for manual flows. */
      discoverResults.addEventListener("paste", (e) => {
        const input = e.target && e.target.closest && e.target.closest('[data-action="track-post-url"]');
        if (!input) return;
        setTimeout(() => {
          const refs = Util.parsePostRefs(input.value || "");
          if (!refs.ids.length && !refs.shares.length) return;
          const tracker = input.closest(".cand-tracker");
          const btn = tracker && tracker.querySelector('[data-action="track-post-confirm"]');
          if (btn) btn.click();
        }, 50);
      });
    }

    /* Helper: try to read the clipboard and pre-fill `input` with the
     * raw text IF it parses as a Reddit URL/ID/share link. Returns
     * true on success, false otherwise (including silent failures). */
    async function tryAutoFillFromClipboard(input) {
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") return false;
        const text = await navigator.clipboard.readText();
        if (!text || typeof text !== "string") return false;
        const refs = Util.parsePostRefs(text);
        if (!refs.ids.length && !refs.shares.length) return false;
        input.value = text.trim();
        /* Tiny visual cue so the user knows it auto-pasted — bg flash. */
        input.classList.add("autopaste-flash");
        setTimeout(() => input.classList.remove("autopaste-flash"), 900);
        /* Auto-submit too — saves a tap. */
        const tracker = input.closest(".cand-tracker");
        const btn = tracker && tracker.querySelector('[data-action="track-post-confirm"]');
        if (btn) btn.click();
        return true;
      } catch (_) {
        /* Permission denied / unsupported / not a Reddit URL — stay
         * silent. The user can still paste manually. */
        return false;
      }
    }

    /* Manual "📋 Paste" button next to the input — acts as an explicit
     * user-gesture wrapper around tryAutoFillFromClipboard for
     * browsers that grant readText only on direct button clicks. */
    async function handleManualClipboardPaste(pasteBtn) {
      const tracker = pasteBtn.closest(".cand-tracker");
      const input = tracker && tracker.querySelector('[data-action="track-post-url"]');
      if (!input) return;
      const ok = await tryAutoFillFromClipboard(input);
      if (!ok) {
        Util.toast("Clipboard didn't contain a Reddit post URL — paste manually below.", "error");
        try { input.focus(); } catch (_) {}
      }
    }

    /* Resolve the Reddit URL/ID/share-link the user pasted into a
     * candidate's tracker input and add it to the currently-open
     * campaign. Uses the same parsing + share-resolution path as the
     * "Add more posts" textarea inside the campaign detail panel. */
    async function handleTrackPostFromCandidate(trackBtn) {
      const tracker = trackBtn.closest(".cand-tracker");
      if (!tracker) return;
      const input = tracker.querySelector('[data-action="track-post-url"]');
      const status = tracker.querySelector(".cand-tracker-status");
      if (!input) return;
      const value = String(input.value || "").trim();
      function showStatus(kind, text) {
        if (!status) return;
        status.hidden = false;
        status.className = "cand-tracker-status meta " + (kind || "");
        status.textContent = text || "";
      }
      if (!value) {
        showStatus("err", "Paste your new post URL first.");
        return;
      }
      const sel = document.getElementById("discover-campaign");
      const campaignId = state.openCampaignId || (sel && sel.value) || null;
      if (!campaignId) {
        showStatus("err", "No active campaign — open one first.");
        return;
      }

      trackBtn.disabled = true;
      const origText = trackBtn.textContent;
      trackBtn.textContent = "Adding…";
      showStatus("", "Resolving…");

      try {
        const refs = Util.parsePostRefs(value);
        let allIds = refs.ids.slice();
        if (refs.shares.length) {
          const urls = refs.shares.map((s) => s.url);
          const { resolved } = await Reddit.resolveShareUrls(urls);
          for (const u of urls) {
            if (resolved[u]) allIds.push(resolved[u]);
          }
        }
        allIds = Util.uniqBy(allIds, (x) => x);
        if (!allIds.length) {
          showStatus("err", "Couldn't extract a Reddit post ID from that. Paste the full https://www.reddit.com/... permalink.");
          trackBtn.disabled = false;
          trackBtn.textContent = origText;
          return;
        }
        const result = Campaigns.addPostIds(campaignId, allIds);
        if (!result) {
          showStatus("err", "Campaign not found.");
          trackBtn.disabled = false;
          trackBtn.textContent = origText;
          return;
        }
        if (result.added === 0) {
          showStatus("ok", "Already tracked in this campaign.");
        } else {
          showStatus("ok", `Added — refreshing "${result.campaign.name}" stats…`);
        }
        input.value = "";
        await openCampaign(result.campaign);
        Util.toast(`Tracked ${result.added || 0} new post${result.added === 1 ? "" : "s"} in "${result.campaign.name}"`, "ok");
        trackBtn.textContent = result.added === 0 ? "Already added ✓" : "Added ✓";
      } catch (err) {
        console.error("[track-post] failed:", err);
        showStatus("err", `Failed: ${(err && err.message) || err}`);
        trackBtn.disabled = false;
        trackBtn.textContent = origText;
      }
    }
  }

  function renderChips() {
    UI.renderSubChips(
      state.knownSubs,
      state.activeSubs,
      (sub) => {
        if (state.activeSubs.has(sub)) state.activeSubs.delete(sub); else state.activeSubs.add(sub);
        persist();
        renderChips();
        markPending(`Toggled r/${sub}`);
      },
      (sub) => {
        state.knownSubs = state.knownSubs.filter((s) => s !== sub);
        state.activeSubs.delete(sub);
        persist();
        renderChips();
        markPending(`Removed r/${sub}`);
      }
    );
  }

  function checkStorageAvailability() {
    if (typeof Campaigns === "undefined" || !Campaigns.canPersist) return;
    if (Campaigns.canPersist()) return;
    showStorageBanner();
  }

  function showStorageBanner() {
    const main = document.querySelector("main");
    if (!main) return;
    if (document.getElementById("storage-banner")) return;
    const banner = document.createElement("div");
    banner.id = "storage-banner";
    banner.className = "banner warn";
    banner.innerHTML = `
      <strong>Browser storage is unavailable.</strong>
      Campaigns and settings will only last for this page session and won't survive a reload.
      This usually means iOS Safari <em>Private Browsing</em> is on, the site is in a webview, or cookies are blocked for reddit.com / this site.
      <span class="hint">Switch off Private Browsing or allow site data, then reload. Saving still works inside the current tab.</span>
    `;
    main.insertBefore(banner, main.firstChild);
  }

  /* Each init step is wrapped in safeRun so a single failure (e.g. one
   * Chart.js call exploding on an exotic browser) can't take down the
   * whole startup sequence. wireSyncSession() runs FIRST after bind so
   * the share-link banner + the export/import buttons get listeners
   * even if any later step throws. */
  /* Each boot step is isolated so one failure cannot leave the page
   * blank. Logged as an error, not a warning: a step that throws part
   * way through takes every listener it had not reached yet with it,
   * which is the kind of half-wired UI that is very hard to diagnose
   * later from user reports. */
  function safeRun(label, fn) {
    try { fn(); }
    catch (err) {
      console.error(`[init] ${label} failed:`, err);
      try { Util.toast(`${label} hit an error — see console.`, "error"); } catch (_) {}
    }
  }

  /* Measure the topbar's rendered height and write it into a CSS
   * variable so the sticky progress banner always docks at the right
   * Y position. Re-runs on resize and when the topbar's content
   * changes (e.g. the user toggles the filters button).
   *
   * Using ResizeObserver where available for pixel-accurate updates;
   * falling back to a debounced resize listener otherwise. */
  function wireTopbarHeightVar() {
    const topbar = document.querySelector(".topbar");
    if (!topbar) return;
    function update() {
      const h = topbar.getBoundingClientRect().height;
      if (!h) return;
      document.documentElement.style.setProperty("--topbar-h", h + "px");
    }
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(topbar);
    }
    window.addEventListener("resize", update);
    /* Re-measure after the page settles + after the next animation
     * frame, since web-fonts loading later can change topbar height. */
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(update);
    }
    setTimeout(update, 200);
    setTimeout(update, 1000);
  }

  /* ---------- First-run nudge ---------- */

  /* The old build had a one-shot starter-pack drawer that appeared only
   * when knownSubs was empty and never came back. The curated bundles it
   * offered now live permanently in the Communities view, so a first-run
   * user just gets pointed there. */
  /* An empty dashboard is a dead end, so a first-time visitor lands on
   * the catalog instead. Demo mode is about to fill the dashboard, and a
   * shared link names its own destination — neither should be hijacked. */
  function nudgeFirstRun() {
    if (state.knownSubs && state.knownSubs.length) return;
    if (window.Demo && Demo.isActive()) return;
    if (window.location.hash && window.location.hash.length > 2) return;
    Router.go("communities", {}, { replace: true });
    if (window.CommunitiesView) CommunitiesView.goToTab("catalog");
  }

  /* ---------- Markdown digest export (PR 3) ---------- */

  /* Build a Signal-friendly campaign summary. Plain text — no Markdown
   * (Signal doesn't render *bold* or _italic_), emoji-led bullet lines
   * so the structure scans visually, and no footer credit. */
  function buildCampaignDigest(campaign, agg, deep) {
    if (!campaign) return "";
    const lines = [];
    lines.push(`📊 ${campaign.name}`);
    const subList = (agg.subs || []).slice(0, 8).map((s) => `r/${s}`).join(", ");
    lines.push(`📝 ${campaign.postIds.length} posts across ${agg.subs.length} sub${agg.subs.length === 1 ? "" : "s"}${subList ? " (" + subList + (agg.subs.length > 8 ? ", …" : "") + ")" : ""}`);
    const goalBit = campaign.goalScore
      ? ` (${Math.round(Math.min(1, agg.totalScore / campaign.goalScore) * 100)}% of ${Util.fmtNum(campaign.goalScore)} goal)`
      : "";
    lines.push(`⬆️ ${Util.fmtNum(agg.totalScore)} upvotes${goalBit}`);
    const cgoalBit = campaign.goalComments
      ? ` (${Math.round(Math.min(1, agg.totalComments / campaign.goalComments) * 100)}% of ${Util.fmtNum(campaign.goalComments)} goal)`
      : "";
    lines.push(`💬 ${Util.fmtNum(agg.totalComments)} comments${cgoalBit}`);
    const top = (agg.posts || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    if (top) {
      lines.push(`🏆 Top: r/${top.subreddit} — ${Util.fmtNum(top.score)} pts, ${Util.fmtNum(top.num_comments)} comments`);
      lines.push(`🔗 ${top.permalink}`);
    }
    if (deep && deep.profile && deep.profile.themes && deep.profile.themes.length) {
      const themes = deep.profile.themes.slice(0, 3).map((t) => t.kind === "phrase" ? `"${t.term}"` : t.term).join(", ");
      lines.push(`🏷️ Themes: ${themes}`);
    }
    if (deep && deep.profile && deep.profile.bestHour >= 0) {
      const raw = String(deep.profile.bestHour).padStart(2, "0") + ":00";
      const vel = deep.profile.bestHourByVelocity >= 0 ? String(deep.profile.bestHourByVelocity).padStart(2, "0") + ":00" : null;
      const tz = Util.getTzLabel();
      if (vel && Math.abs(deep.profile.bestHour - deep.profile.bestHourByVelocity) >= 4) {
        lines.push(`⏰ Best hour: ${raw} ${tz} (raw) · ${vel} ${tz} (velocity-corrected — trust this one)`);
      } else {
        lines.push(`⏰ Best hour: ${raw} ${tz}${vel ? ` (velocity peak: ${vel})` : ""}`);
      }
    }
    return lines.join("\n");
  }

  /* ---------- Saved searches / watchlists (PR 3) ---------- */

  function loadSavedSearches() {
    try { return JSON.parse(localStorage.getItem("rj.savedSearches") || "[]"); }
    catch (_) { return []; }
  }
  function saveSavedSearches(list) {
    try { localStorage.setItem("rj.savedSearches", JSON.stringify(list)); }
    catch (_) {}
  }
  function buildCurrentSearchSnapshot() {
    return {
      id: Math.random().toString(36).slice(2, 10),
      createdAt: Date.now(),
      activeSubs: Array.from(state.activeSubs),
      listing: state.listing,
      timeWindow: state.timeWindow,
      limit: state.limit,
      searchQuery: state.searchQuery,
      postsSubFilter: state.postsSubFilter,
      postsScoreMin: state.postsScoreMin || 0,
    };
  }
  function applySavedSearch(snap) {
    if (!snap) return;
    state.activeSubs = new Set(snap.activeSubs || []);
    state.listing    = snap.listing || state.listing;
    state.timeWindow = snap.timeWindow || state.timeWindow;
    state.limit      = snap.limit || state.limit;
    state.searchQuery     = snap.searchQuery || "";
    state.postsSubFilter  = snap.postsSubFilter || "";
    state.postsScoreMin   = snap.postsScoreMin || 0;
    persist();
    renderChips();
    const sIn = document.getElementById("posts-title-search");
    if (sIn) sIn.value = state.searchQuery;
    const lSel = document.getElementById("listing-select");
    if (lSel) lSel.value = state.listing;
    const tSel = document.getElementById("time-select");
    if (tSel) tSel.value = state.timeWindow;
    const limSel = document.getElementById("limit-select");
    if (limSel) limSel.value = String(state.limit);
    rerenderAll();
    markPending(`Loaded saved view "${snap.name || "unnamed"}"`);
  }

  /* ---------- Image / media preview modal (PR 3) ---------- */

  function openMediaPreview(url, alt) {
    const modal = document.getElementById("media-preview");
    const frame = document.getElementById("media-preview-frame");
    if (!modal || !frame) return;
    frame.innerHTML = `<img src="${Util.escapeHtml(url)}" alt="${Util.escapeHtml(alt || "")}" loading="lazy" />`;
    modal.hidden = false;
    document.body.classList.add("modal-open");
  }
  function closeMediaPreview() {
    const modal = document.getElementById("media-preview");
    const frame = document.getElementById("media-preview-frame");
    if (frame) frame.innerHTML = "";
    if (modal) modal.hidden = true;
    document.body.classList.remove("modal-open");
  }
  function wireMediaPreview() {
    const modal = document.getElementById("media-preview");
    if (!modal) return;
    modal.addEventListener("click", (e) => {
      if (e.target === modal || (e.target.closest && e.target.closest('[data-action="close-media-preview"]'))) {
        closeMediaPreview();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) closeMediaPreview();
    });
    const tbody = document.getElementById("posts-tbody");
    if (tbody) {
      tbody.addEventListener("click", (e) => {
        const thumb = e.target.closest && e.target.closest("[data-media-thumb]");
        if (!thumb) return;
        e.preventDefault();
        e.stopPropagation();
        const url = thumb.dataset.mediaThumb;
        const alt = thumb.dataset.mediaAlt || "";
        if (url) openMediaPreview(url, alt);
      });
    }
  }

  /* ---------- Predict / cascade / rewrite (PR 5) ---------- */

  function wirePredictCard() {
    const card = document.getElementById("predict-card");
    const body = document.getElementById("predict-body");
    if (!card || !body) return;
    UI.renderPredictAndRewrite(body);
    function recompute() {
      const input = body.querySelector('[data-role="predict-draft"]');
      const draft = input ? input.value.trim() : "";
      const subs = Array.from(state.activeSubs);
      const predictions = subs.map((sub) =>
        Analysis.predictPostScore(sub, draft, { posts: state.posts })
      );
      const rewrites = draft ? Analysis.rewriteTitle(draft) : [];
      UI.renderPredictResults(body, predictions, rewrites);
    }
    body.addEventListener("input", (e) => {
      if (e.target.matches('[data-role="predict-draft"]')) {
        clearTimeout(body._predictDebounce);
        body._predictDebounce = setTimeout(recompute, 200);
      }
    });
    body.addEventListener("click", (e) => {
      const pick = e.target.closest && e.target.closest("[data-rewrite-pick]");
      if (!pick) return;
      const input = body.querySelector('[data-role="predict-draft"]');
      if (input) {
        input.value = pick.dataset.rewritePick;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    if (state.posts.length > 0 && state.activeSubs.size > 0) {
      card.hidden = false;
    }
  }

  function wireCascadeCard() {
    const card = document.getElementById("cascade-card");
    const sel = document.getElementById("cascade-source");
    const btn = document.getElementById("cascade-build");
    const out = document.getElementById("cascade-results");
    if (!card || !sel || !btn || !out) return;
    btn.addEventListener("click", () => {
      const v = sel.value;
      let subs = [];
      if (v === "__active") {
        subs = Array.from(state.activeSubs);
      } else if (v && v.startsWith("campaign:")) {
        const id = v.slice(9);
        const summary = state.campaignSummaries[id];
        subs = summary ? (summary.subs || []) : [];
      }
      const schedule = Analysis.cascadeSchedule(subs, {
        posts: state.posts,
        subProfiles: state.subProfiles || {},
      });
      UI.renderCascadeSchedule(out, schedule);
    });
    if (state.posts.length > 0 && (state.activeSubs.size > 0 || Object.keys(state.campaignSummaries || {}).length > 0)) {
      card.hidden = false;
    }
  }

  /* ---------- Watch mode (PR 6) ---------- */

  const WATCH_INTERVAL_MIN = 5;
  let watchTimer = null;
  let watchLastSnapshot = null;

  function startWatch(campaignId) {
    if (!campaignId) return;
    stopWatch();
    state.watchedCampaignId = campaignId;
    watchTimer = setInterval(() => watchTick(campaignId), WATCH_INTERVAL_MIN * 60 * 1000);
    refreshWatchToggleUI(true);
    Util.toast(`Watching campaign — auto-refresh every ${WATCH_INTERVAL_MIN} min.`, "ok");
  }
  function stopWatch() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    state.watchedCampaignId = null;
    watchLastSnapshot = null;
    refreshWatchToggleUI(false);
  }
  async function watchTick(campaignId) {
    try {
      const c = Campaigns.get(campaignId);
      if (!c) { stopWatch(); return; }
      const fresh = await Campaigns.fetchAggregated(c, { force: true });
      const totalScore = fresh.totalScore || 0;
      const totalComments = fresh.totalComments || 0;
      if (watchLastSnapshot) {
        const dScore = totalScore - watchLastSnapshot.totalScore;
        if (totalScore >= 1000 && watchLastSnapshot.totalScore < 1000) Util.toast(`🎯 "${c.name}" hit 1k upvotes!`, "ok");
        if (totalScore >= 10000 && watchLastSnapshot.totalScore < 10000) Util.toast(`🚀 "${c.name}" hit 10k upvotes!`, "ok");
        if (totalComments >= 100 && watchLastSnapshot.totalComments < 100) Util.toast(`💬 "${c.name}" passed 100 comments!`, "ok");
        if (dScore < 0 && Math.abs(dScore) > watchLastSnapshot.totalScore * 0.5) Util.toast(`⚠️ "${c.name}" dropped 50%+ in upvotes — possible mass downvote / removal`, "error");
      }
      watchLastSnapshot = { totalScore, totalComments };
      state.campaignSummaries[campaignId] = fresh;
      if (state.openCampaignId === campaignId) {
        try { await openCampaign(c); } catch (_) {}
      }
    } catch (err) {
      console.warn("[watch] tick failed:", err && err.message);
    }
  }
  function refreshWatchToggleUI(isOn) {
    const slot = document.getElementById("watch-toggle-slot");
    if (slot && state.openCampaignId) {
      UI.renderWatchToggle(slot, isOn, WATCH_INTERVAL_MIN);
    }
  }

  /* ---------- A/B compare (PR 6) ---------- */

  function wireABCompare() {
    const card = document.getElementById("ab-card");
    const selA = document.getElementById("ab-campaign-a");
    const selB = document.getElementById("ab-campaign-b");
    const btn = document.getElementById("ab-compare");
    const out = document.getElementById("ab-results");
    if (!card || !selA || !selB || !btn || !out) return;
    btn.addEventListener("click", () => {
      const aId = selA.value, bId = selB.value;
      if (!aId || !bId) { Util.toast("Pick two campaigns to compare.", "error"); return; }
      if (aId === bId) { Util.toast("Pick two DIFFERENT campaigns.", "error"); return; }
      const a = Object.assign({}, Campaigns.get(aId), state.campaignSummaries[aId] || {});
      const b = Object.assign({}, Campaigns.get(bId), state.campaignSummaries[bId] || {});
      const cmp = Analysis.compareCampaigns(a, b);
      UI.renderCampaignCompare(out, cmp);
    });
  }

  /* ---------- Calendar (PR 6) ---------- */

  function paintCalendar() {
    const body = document.getElementById("calendar-body");
    if (!body) return;
    const list = (typeof Campaigns !== "undefined" && Campaigns.list) ? Campaigns.list() : [];
    UI.renderCampaignCalendar(body, list, state.campaignSummaries || {});
  }

  function wireCalendar() {
    const body = document.getElementById("calendar-body");
    if (!body) return;
    body.addEventListener("click", (e) => {
      const row = e.target.closest && e.target.closest(".cal-row[data-campaign-id]");
      if (!row) return;
      const c = Campaigns.get(row.dataset.campaignId);
      if (c) openCampaign(c);
    });
    paintCalendar();
  }

  /* ---------- Volunteer coordination (PR 6) ---------- */

  function loadVolunteerClaims() {
    try { return JSON.parse(localStorage.getItem("rj.volClaims") || "[]"); }
    catch (_) { return []; }
  }
  function saveVolunteerClaims(list) {
    try { localStorage.setItem("rj.volClaims", JSON.stringify(list)); }
    catch (_) {}
  }
  function loadVolunteerName() {
    try { return localStorage.getItem("rj.volName") || ""; }
    catch (_) { return ""; }
  }
  function saveVolunteerName(name) {
    try { localStorage.setItem("rj.volName", String(name || "")); }
    catch (_) {}
  }

  function wireVolunteer() {
    const sel = document.getElementById("vol-source");
    const btn = document.getElementById("vol-load");
    const body = document.getElementById("vol-body");
    if (!sel || !btn || !body) return;
    function render() {
      const v = sel.value;
      let subs = [];
      if (v === "__active") subs = Array.from(state.activeSubs);
      else if (v && v.startsWith("campaign:")) {
        const id = v.slice(9);
        const summary = state.campaignSummaries[id];
        subs = summary ? (summary.subs || []) : [];
      }
      const claims = loadVolunteerClaims();
      const me = loadVolunteerName();
      UI.renderVolunteerCoverage(body, claims, subs, me);
    }
    btn.addEventListener("click", render);
    body.addEventListener("input", (e) => {
      if (e.target.id === "vol-name") {
        saveVolunteerName(e.target.value);
      }
    });
    body.addEventListener("click", (e) => {
      const claim = e.target.closest && e.target.closest('[data-action="vol-claim"]');
      const release = e.target.closest && e.target.closest('[data-action="vol-unclaim"]');
      const sub = (claim || release) && (claim || release).dataset.sub;
      if (!sub) return;
      let claims = loadVolunteerClaims();
      const name = loadVolunteerName() || "anon";
      if (claim) {
        claims = claims.filter((c) => c.sub.toLowerCase() !== sub.toLowerCase());
        claims.push({ sub, name, claimedAt: Date.now() });
        saveVolunteerClaims(claims);
        Util.toast(`Claimed r/${sub} as ${name}.`, "ok");
      } else if (release) {
        claims = claims.filter((c) => c.sub.toLowerCase() !== sub.toLowerCase());
        saveVolunteerClaims(claims);
        Util.toast(`Released r/${sub}.`, "ok");
      }
      render();
    });
  }

  function wireBackToTop() {
    const btn = document.getElementById("back-to-top");
    if (!btn) return;
    const SHOW_AT = window.innerHeight || 800;
    function update() {
      const past = (window.scrollY || window.pageYOffset || 0) > SHOW_AT;
      btn.classList.toggle("visible", past);
    }
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    btn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  /* Pagination handlers for the recommendation surfaces.
   *
   * Renderers emit page / size buttons with attributes like
   *   data-targeting-page="next"   data-targeting-surface="ai"
   *   data-targeting-size="50"     data-targeting-surface="inline"
   *   data-discover-page="prev"    data-discover-surface="new"
   *   data-discover-size="all"     data-discover-surface="already"
   *
   * Single document-level click handler routes every button into
   * state.recommend.{targeting|discover}.<slot> and re-renders the
   * affected surface from its stashed (campaign, targets, container)
   * triplet. Doing this via delegation means the renderer is free
   * to rebuild its DOM on every render without us having to re-bind
   * handlers each time. */
  function wireRecommendPagination() {
    document.addEventListener("click", (e) => {
      const t = e.target;

      const tgtSize = t.closest && t.closest("[data-targeting-size]");
      if (tgtSize) {
        const surface = tgtSize.dataset.targetingSurface;
        const slot = state.recommend.targeting[surface];
        if (!slot) return;
        const sz = tgtSize.dataset.targetingSize;
        slot.pageSize = (sz === "all" ? "all" : Number(sz) || 25);
        slot.page = 0;
        rerenderTargeting(surface);
        return;
      }

      const tgtPage = t.closest && t.closest("[data-targeting-page]");
      if (tgtPage) {
        const surface = tgtPage.dataset.targetingSurface;
        const slot = state.recommend.targeting[surface];
        if (!slot) return;
        slot.page = (slot.page || 0) + (tgtPage.dataset.targetingPage === "next" ? 1 : -1);
        if (slot.page < 0) slot.page = 0;
        rerenderTargeting(surface);
        return;
      }

      const dscSize = t.closest && t.closest("[data-discover-size]");
      if (dscSize) {
        const surface = dscSize.dataset.discoverSurface;
        const slot = state.recommend.discover[surface];
        if (!slot) return;
        const sz = dscSize.dataset.discoverSize;
        slot.pageSize = (sz === "all" ? "all" : Number(sz) || 25);
        slot.page = 0;
        rerenderDiscovery();
        return;
      }

      const dscPage = t.closest && t.closest("[data-discover-page]");
      if (dscPage) {
        const surface = dscPage.dataset.discoverSurface;
        const slot = state.recommend.discover[surface];
        if (!slot) return;
        slot.page = (slot.page || 0) + (dscPage.dataset.discoverPage === "next" ? 1 : -1);
        if (slot.page < 0) slot.page = 0;
        rerenderDiscovery();
        return;
      }
    });
  }

  /* ---------- Theme + navigation drawer ---------- */

  function wireTheme() {
    const btn = document.getElementById("theme-toggle");
    const icon = document.getElementById("theme-toggle-icon");
    const label = document.getElementById("theme-toggle-label");

    function paint() {
      const mode = Theme.get();
      if (icon) icon.textContent = Theme.icon(mode);
      if (label) label.textContent = Theme.label(mode);
      for (const b of document.querySelectorAll("#theme-picker [data-theme-set]")) {
        const on = b.dataset.themeSet === mode;
        b.classList.toggle("active", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
      }
    }

    if (btn) btn.addEventListener("click", () => { Theme.cycle(); paint(); });
    for (const b of document.querySelectorAll("#theme-picker [data-theme-set]")) {
      b.addEventListener("click", () => { Theme.set(b.dataset.themeSet); paint(); });
    }

    /* Chart.js reads its colours from CSS variables at construction
     * time, so existing canvases keep the old palette until they are
     * rebuilt. Re-render the visible view on every theme change. */
    Theme.onChange(() => {
      paint();
      Router.invalidate();
    });
    paint();
  }

  function setRailOpen(open) {
    const rail = document.getElementById("rail");
    if (!rail) return;
    rail.classList.toggle("open", open);
    let scrim = document.getElementById("rail-scrim");
    if (open && !scrim) {
      scrim = document.createElement("div");
      scrim.id = "rail-scrim";
      scrim.className = "rail-scrim";
      scrim.addEventListener("click", () => setRailOpen(false));
      document.body.appendChild(scrim);
    } else if (!open && scrim) {
      scrim.remove();
    }
  }

  /* ---------- Boot ---------- */

  function init() {
    safeRun("loadPersisted", loadPersisted);
    safeRun("registerRoutes", () => Router.wireNav());
    safeRun("bind", bind);
    safeRun("wireTopbarHeightVar", wireTopbarHeightVar);
    safeRun("subIndex", () => {
      /* Warm the local subreddit index so the catalog can show real
       * member counts and similarity search has something to compare
       * against before the first network call. */
      SubIndex.load().then(() => {
        Discovery.invalidateSpheres();
        if (Router.current() === "communities") CommunitiesView.render();
      }).catch(() => {});
    });
    safeRun("wireSyncSession", wireSyncSession);
    safeRun("renderChips", renderChips);
    safeRun("router", () => Router.start());
    safeRun("hydratePostCache", () => {
      /* Hydrate from the persistent post cache before the first render
       * so a reload shows the previous data instead of an empty state.
       * Async because the gzip decode is. */
      hydrateFromPostCache().then((ok) => {
        if (ok) {
          rerenderAll();
          showCachedActionBanner();
        }
      }).catch((e) => console.warn("[postcache] hydrate failed:", e && e.message));
    });
    safeRun("rerenderAll", rerenderAll);
    safeRun("wireMediaPreview", wireMediaPreview);
    safeRun("nudgeFirstRun", nudgeFirstRun);
    safeRun("showInitialActionBanner", () => {
      if (state.cache.hasCache && state.posts.length) return;
      Util.setActionPhase("pending", describePendingFetch());
    });
    safeRun("refreshAllCampaignSummaries", () => refreshAllCampaignSummaries());
    safeRun("wirePredictCard", wirePredictCard);
    safeRun("wireCascadeCard", wireCascadeCard);
    safeRun("wireCalendar", wireCalendar);
    safeRun("wireABCompare", wireABCompare);
    safeRun("wireVolunteer", wireVolunteer);
    safeRun("wireComposer", wireComposer);
    safeRun("wireRecommendPagination", wireRecommendPagination);
    safeRun("wireBackToTop", wireBackToTop);
    safeRun("checkStorageAvailability", checkStorageAvailability);
    safeRun("demoMode", () => { if (window.Demo) Demo.maybeActivate(); });
  }

  /* Public surface for the view modules. Keeping this explicit — rather
   * than letting views reach into app internals — makes it obvious what
   * the boundary is. */
  window.App = {
    state: state,
    filteredPosts: filteredPosts,
    renderPostsView: renderPostsView,
    renderCrossPostsView: renderCrossPostsView,
    renderChips: renderChips,
    rerenderAll: rerenderAll,
    rerenderLight: rerenderLight,
    markPending: markPending,
    refreshData: refreshData,
    loadCampaign: loadCampaign,
    openCampaign: openCampaign,
    refreshCampaignSummaries: refreshAllCampaignSummaries,
    renderTargetingInto: renderTargetingInto,
    openComposer: function (id) { return openComposer(id); },
    openPostDetail: openPostDetail,
    runDiscovery: function () { return _runDiscover && _runDiscover(); },
    buildCampaignDigest: buildCampaignDigest,
    updateRailCounts: updateRailCounts,
    setSettingsOpen: setSettingsOpen,
  };

  /* ============================================================
   * Markdown composer + crossposter
   *
   * See cloudflare-worker/SETUP.md and js/composer.js for the
   * broader workflow. The composer is opened from a "Compose &
   * cross-post" button in the campaign-detail panel; this module
   * wires the modal's DOM up to Composer's state model and to
   * Reddit/Campaigns helpers.
   * ============================================================ */
  let composerState = null;       // working copy of Composer.defaultDraft for the open campaign
  let composerSaveTimer = null;
  let composerImageBlob = null;   // local-file image (Blob)
  let composerImageUrl = null;    // object URL for preview

  function composerRefs() {
    return {
      /* Renamed from "composer-modal" -> "composer-sidebar" when the
       * composer migrated from a centered modal to a right-anchored
       * sidebar overlay. The DOM id was renamed in lockstep so the
       * IDs in CSS / aria-labelledby / Sidebar.open() all point at
       * the same element. */
      modal:     document.getElementById("composer-sidebar"),
      title:     document.getElementById("composer-title"),
      titleC:    document.getElementById("composer-title-counter"),
      body:      document.getElementById("composer-body"),
      bodyC:     document.getElementById("composer-body-counter"),
      bodyHint:  document.getElementById("composer-body-hint"),
      preview:   document.getElementById("composer-preview"),
      linkMode:  document.getElementById("composer-link-mode"),
      linkUrl:   document.getElementById("composer-link-url"),
      imageUrl:  document.getElementById("composer-image-url"),
      imageInsert: document.getElementById("composer-image-insert"),
      imageDrop: document.getElementById("composer-image-drop"),
      imageFile: document.getElementById("composer-image-file"),
      imageStatus: document.getElementById("composer-image-status"),
      imagePreview: document.getElementById("composer-image-preview"),
      aiCopy:    document.getElementById("composer-ai-copy"),
      aiPaste:   document.getElementById("composer-ai-paste"),
      aiInsertReplace: document.getElementById("composer-ai-insert-replace"),
      aiInsertAppend:  document.getElementById("composer-ai-insert-append"),
      aiVariants: document.getElementById("composer-ai-variants"),
      aiWords:    document.getElementById("composer-ai-words"),
      targets:   document.getElementById("composer-targets-list"),
      targetsAdd:    document.getElementById("composer-targets-add"),
      targetsAddBtn: document.getElementById("composer-targets-add-btn"),
      fromRecommended: document.getElementById("composer-targets-from-recommended"),
      fromActive:  document.getElementById("composer-targets-from-active"),
      modeBtns:  document.querySelectorAll("#composer-sidebar [data-composer-mode]"),
      paneBtns:  document.querySelectorAll("#composer-sidebar [data-composer-pane]"),
      clearBtn:  document.getElementById("composer-clear-draft"),
      savedMeta: document.getElementById("composer-saved-meta"),
      context:   document.getElementById("composer-context"),
      selectAllBtn:  document.getElementById("composer-targets-all"),
      selectNoneBtn: document.getElementById("composer-targets-none"),
      selectUnpostedBtn: document.getElementById("composer-targets-unposted"),
      selectCount:   document.getElementById("composer-targets-count"),
      copyRichBtn:   document.getElementById("composer-copy-rich"),
    };
  }

  /* Per-sub count of how many of the currently-open campaign's posts
   * already landed in each subreddit. The composer renders this as a
   * small "3 posts" badge next to each target so the user can see at
   * a glance which subs they've already saturated.
   *
   * Source of truth: the campaign's postIds joined to state.posts
   * (the same in-memory pool the rest of the dashboard uses). Posts
   * that haven't yet been fetched return count = 0; we deliberately
   * don't show the badge for 0 because we can't tell apart "truly
   * never posted there" from "not fetched yet". */
  function computeCampaignPostCountsBySub(campaignId) {
    const out = new Map();
    if (!campaignId || typeof Campaigns === "undefined") return out;
    const c = Campaigns.get(campaignId);
    if (!c) return out;
    const byId = new Map();
    for (const p of (state.posts || [])) {
      if (p && p.id) byId.set(p.id, p);
    }
    for (const id of (c.postIds || [])) {
      const p = byId.get(id);
      if (!p || !p.subreddit) continue;
      const k = String(p.subreddit).toLowerCase();
      out.set(k, (out.get(k) || 0) + 1);
    }
    return out;
  }

  function openComposer(campaignId) {
    if (typeof Composer === "undefined") {
      Util.toast("Composer not loaded.", "error");
      return;
    }
    const refs = composerRefs();
    if (!refs.modal) return;

    composerState = Composer.loadDraft(campaignId);

    /* Seed targets from the campaign's recommended targets if the
     * draft is fresh and empty (first open). Avoids overwriting on
     * re-opens after the user manually curated their list. */
    if (!composerState.targets.length) {
      const c = (typeof Campaigns !== "undefined" && Campaigns.get) ? Campaigns.get(campaignId) : null;
      const subs = composerSeedTargets(c);
      composerState.targets = subs.map((sub, i) => ({
        sub,
        checked: i < 5,    // pre-check first 5 so the user has something to fire on
        seed: i === 0,
        posted: false,
      }));
    }

    /* Hydrate DOM from state */
    refs.title.value = composerState.title || "";
    refs.body.value = composerState.body || "";
    refs.linkMode.checked = !!composerState.isLinkPost;
    refs.linkUrl.value = composerState.linkUrl || "";
    refs.imageUrl.value = composerState.imageUrl || "";
    refs.modeBtns.forEach((b) => {
      const on = b.dataset.composerMode === composerState.mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
    /* Mobile pane = source by default. */
    document.body.classList.add("composer-pane-source");
    document.body.classList.remove("composer-pane-preview");
    refs.paneBtns.forEach((b) => {
      const on = b.dataset.composerPane === "source";
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });

    /* Campaign-name context badge — feeds the .sidebar-subtitle
     * line in the composer's sidebar header. */
    if (refs.context) {
      const c = (typeof Campaigns !== "undefined" && Campaigns.get) ? Campaigns.get(campaignId) : null;
      const text = c ? `for "${c.name}"` : "";
      refs.context.textContent = text;
      refs.context.hidden = !text;
    }

    /* Show via the Sidebar module so it gets the standard backdrop +
     * ESC + body-class treatment the other section sidebars use.
     * The composer's sidebar id (#composer-sidebar) is registered
     * with Sidebar; opening it just reveals the existing DOM (which
     * holds composerState wired into the input listeners). */
    if (typeof Sidebar !== "undefined") {
      Sidebar.open({
        id: "composer-sidebar",
        onClose: () => {
          /* The pane-toggle classes live on <body> (see CSS in the
           * @media (max-width: 880px) block); clear them when the
           * sidebar closes so a stale one doesn't bleed into the
           * next opener. */
          document.body.classList.remove("composer-pane-source", "composer-pane-preview");
        },
      });
    } else {
      refs.modal.hidden = false;
    }
    refreshComposer();
    setTimeout(() => refs.title.focus(), 50);
  }

  function closeComposer() {
    if (typeof Sidebar !== "undefined" && Sidebar.activeId() === "composer-sidebar") {
      Sidebar.close();
    } else {
      const refs = composerRefs();
      if (refs.modal) refs.modal.hidden = true;
    }
    document.body.classList.remove("composer-pane-source", "composer-pane-preview");
  }

  function composerSeedTargets(campaign) {
    const seen = new Set();
    const out = [];

    /* Active subs from the dashboard chip set first (most useful
     * for a fresh campaign with no posts yet). */
    if (state.activeSubs && state.activeSubs.size) {
      for (const s of state.activeSubs) {
        if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
      }
    }
    /* Then the campaign's recommended targets if computed. */
    if (campaign && state.subProfiles) {
      try {
        const summary = aggregateCampaignFromState(campaign);
        if (summary && summary.posts && summary.posts.length) {
          const profile = Analysis.campaignProfile(summary.posts, campaign);
          const targets = Analysis.recommendTargets(profile, state.subProfiles, { limit: 12 });
          for (const t of targets || []) {
            const sub = t.sub || t.canonical;
            if (sub && !seen.has(sub.toLowerCase())) { seen.add(sub.toLowerCase()); out.push(sub); }
          }
        }
      } catch (_) {}
    }
    return out;
  }

  /* Helper: rebuild a campaign aggregate from the resolved-posts
   * cache (avoids a network round-trip just to seed targets). */
  function aggregateCampaignFromState(campaign) {
    if (!campaign) return null;
    const have = (campaign.postIds || []).map((id) =>
      (state.posts || []).find((p) => p.id === id)
    ).filter(Boolean);
    return { posts: have };
  }

  /* Re-render every reactive piece of the composer modal from
   * composerState. Called on every input change. */
  function refreshComposer() {
    if (!composerState) return;
    const refs = composerRefs();
    if (!refs.modal || refs.modal.hidden) return;

    /* Title counter */
    const tlen = (composerState.title || "").length;
    refs.titleC.textContent = `${tlen} / ${Composer.LIMITS.titleMax}`;
    refs.titleC.classList.toggle("warn", tlen > Composer.LIMITS.titleMax - 30);
    refs.titleC.classList.toggle("bad",  tlen > Composer.LIMITS.titleMax);

    /* Body counter */
    const blen = (composerState.body || "").length;
    refs.bodyC.textContent = `${blen} / ${Composer.LIMITS.bodyMax}`;
    refs.bodyC.classList.toggle("warn", blen > Composer.LIMITS.bodyMax - 5000);
    refs.bodyC.classList.toggle("bad",  blen > Composer.LIMITS.bodyMax);

    /* Body hint shows whichever target's URL is currently the worst-
     * fitting so the user knows mobile may truncate. */
    const urls = Composer.emitSubmitUrls(composerState);
    const longest = urls.reduce((m, u) => (u.length > (m ? m.length : 0) ? u : m), null);
    if (longest && longest.warn === "hard") {
      refs.bodyHint.textContent = `r/${longest.sub} URL is ${longest.length} chars — over 8 KB iOS limit.`;
      refs.bodyHint.className = "composer-hint bad";
    } else if (longest && longest.warn === "soft") {
      refs.bodyHint.textContent = `r/${longest.sub} URL is ${longest.length} chars — close to 8 KB iOS limit.`;
      refs.bodyHint.className = "composer-hint warn";
    } else {
      refs.bodyHint.textContent = "";
      refs.bodyHint.className = "composer-hint";
    }

    /* Live preview */
    refs.preview.innerHTML = Composer.renderMarkdown(composerState.body || "");

    /* Targets — pass in per-sub post counts so the renderer can
     * display a "3 posts" badge for subs that already have campaign
     * coverage. */
    const counts = computeCampaignPostCountsBySub(composerState.campaignId);
    refs.targets.innerHTML = renderTargetsHtml(composerState, urls, counts);

    /* Selection summary in the bulk-select strip:
     *   "12 of 18 selected · 4 already posted"
     * Posted figure is the count of targets the USER has marked
     * posted in this composer session (from .posted), separate from
     * the per-sub campaign count above (which sees ALL campaign
     * posts, including those added before the composer was opened). */
    if (refs.selectCount) {
      const total = composerState.targets.length;
      const checked = composerState.targets.filter((t) => t.checked).length;
      const posted = composerState.targets.filter((t) => t.posted).length;
      const parts = [`${checked} of ${total} selected`];
      if (posted) parts.push(`${posted} marked posted`);
      refs.selectCount.textContent = total ? parts.join(" · ") : "";
    }

    /* Persist debounced */
    if (composerSaveTimer) clearTimeout(composerSaveTimer);
    composerSaveTimer = setTimeout(() => {
      Composer.saveDraft(composerState);
      const meta = composerRefs().savedMeta;
      if (meta) meta.textContent = "Draft saved · " + new Date().toLocaleTimeString();
    }, 500);
  }

  function renderTargetsHtml(draft, urls, counts) {
    const urlBySub = new Map(urls.map((u) => [u.sub, u]));
    const countMap = counts || new Map();
    const rows = (draft.targets || []).map((t, idx) => {
      const u = urlBySub.get(t.sub);
      const counter = u
        ? `<span class="url-counter ${u.warn === "hard" ? "bad" : u.warn === "soft" ? "warn" : ""}">${u.length} / 8000</span>`
        : "";
      /* Existing-post count badge. Pulled from the campaign's
       * resolved postIds joined to state.posts. */
      const existingCount = countMap.get(t.sub.toLowerCase()) || 0;
      const countBadge = existingCount > 0
        ? `<span class="campaign-post-count" title="${existingCount} ${existingCount === 1 ? "post" : "posts"} from this campaign already in r/${Util.escapeHtml(t.sub)}. Consider whether another post here adds value.">${existingCount} ${existingCount === 1 ? "post" : "posts"}</span>`
        : "";
      const submitBtn = u
        ? `<a class="btn small primary" href="${Util.escapeHtml(u.url)}" target="_blank" rel="noopener" data-composer-action="open-submit" data-sub="${Util.escapeHtml(t.sub)}">Open submit</a>`
        : "";
      const truncateBtn = (u && u.warn === "hard")
        ? `<button type="button" class="btn small ghost" data-composer-action="truncate-target" data-sub="${Util.escapeHtml(t.sub)}" title="Trim this target's body to fit the 8 KB cap">Truncate to fit</button>`
        : "";
      const clipboardBtn = composerImageBlob
        ? `<button type="button" class="btn small ghost" data-composer-action="copy-image" data-sub="${Util.escapeHtml(t.sub)}" title="Copy attached image to clipboard so you can paste it on Reddit's submit page">Copy img</button>`
        : "";
      /* Copy this target's body as RICH TEXT (text/html + plain
       * fallback) — for users whose 'Open submit' lands them in
       * Reddit's mobile app, which is rich-text-only and renders
       * pasted markdown literally. Pasting HTML on the app's
       * body field carries through bold/italic/lists/headings/
       * quotes/links as native rich-text. */
      const copyBodyBtn = `<button type="button" class="btn small ghost" data-composer-action="copy-target-body" data-sub="${Util.escapeHtml(t.sub)}" title="Copy this body as rich text. Use before Open submit if you'll be pasting into Reddit's mobile app — its editor is rich-text-only and ignores raw markdown.">📋 Body</button>`;
      const editor = (draft.mode === "per-target" && t.checked) ? `
        <div class="composer-target-editor">
          <label class="group-label">Title (per-target)</label>
          <input type="text" data-composer-action="edit-target-title" data-sub="${Util.escapeHtml(t.sub)}" maxlength="320"
                 placeholder="defaults to canonical title — edit for sub-specific tweaks"
                 value="${Util.escapeHtml(t.title || "")}" />
          <label class="group-label">Body (per-target)</label>
          <textarea rows="6" data-composer-action="edit-target-body" data-sub="${Util.escapeHtml(t.sub)}"
                    placeholder="defaults to canonical body — edit for sub-specific intros / flair etc.">${Util.escapeHtml(t.body != null ? t.body : "")}</textarea>
          <div class="row gap">
            <button type="button" class="btn small ghost" data-composer-action="sync-from-master" data-sub="${Util.escapeHtml(t.sub)}">Sync from master</button>
          </div>
        </div>
      ` : "";
      const markPosted = t.checked && !t.posted ? `
        <form class="composer-mark-posted-form" data-composer-action="mark-posted-form" data-sub="${Util.escapeHtml(t.sub)}">
          <input type="url" placeholder="Paste resulting Reddit URL here…"
                 data-composer-action="mark-posted-input" data-sub="${Util.escapeHtml(t.sub)}" />
          <button type="submit" class="btn small">Mark posted</button>
        </form>
      ` : "";
      const seedBadge = t.seed && t.checked ? `<span class="seed-badge" title="Post here first">1st</span>` : "";
      return `
        <div class="composer-target-row ${t.posted ? "posted" : ""}">
          <input type="checkbox" data-composer-action="toggle-target" data-sub="${Util.escapeHtml(t.sub)}" ${t.checked ? "checked" : ""} aria-label="Include r/${Util.escapeHtml(t.sub)}" />
          <span class="composer-target-sub">r/${Util.escapeHtml(t.sub)}</span>
          <span class="composer-target-meta">
            ${seedBadge}
            ${countBadge}
            ${counter}
            ${t.posted ? `<a href="${Util.escapeHtml(t.postedUrl || "#")}" target="_blank" rel="noopener" class="hint">view post ↗</a>` : ""}
          </span>
          <span class="composer-target-actions">
            ${submitBtn}
            ${copyBodyBtn}
            ${truncateBtn}
            ${clipboardBtn}
            ${t.checked && !t.seed ? `<button type="button" class="btn small ghost" data-composer-action="make-seed" data-sub="${Util.escapeHtml(t.sub)}" title="Make this the seed (post first)">★</button>` : ""}
            <button type="button" class="btn small ghost" data-composer-action="remove-target" data-sub="${Util.escapeHtml(t.sub)}" aria-label="Remove r/${Util.escapeHtml(t.sub)}">×</button>
          </span>
          ${markPosted}
          ${editor}
        </div>
      `;
    }).join("");
    if (!rows) {
      return `<div class="empty">No targets yet — paste subs in the input above, or "+ From recommended"/"+ From active subs".</div>`;
    }
    return rows;
  }

  function wireComposer() {
    const refs = composerRefs();
    if (!refs.modal) return;

    /* Close + open affordances. The Sidebar module already binds
     * data-sidebar-close + ESC + backdrop click document-wide;
     * closeComposer() runs as the onClose hook. We just need to
     * own the OPEN delegation here. */
    document.addEventListener("click", (e) => {
      /* Legacy data-action="close-composer-modal" is still emitted
       * by some templated content — treat it the same as the new
       * data-sidebar-close. */
      const legacyClose = e.target.closest && e.target.closest('[data-action="close-composer-modal"]');
      if (legacyClose) { e.preventDefault(); closeComposer(); }
      const open = e.target.closest && e.target.closest('[data-action="open-composer"]');
      if (open) {
        e.preventDefault();
        const cid = open.dataset.campaignId || state.openCampaignId;
        openComposer(cid);
      }
    });

    /* Title + body inputs */
    refs.title.addEventListener("input", () => {
      composerState.title = refs.title.value.slice(0, Composer.LIMITS.titleMax);
      refreshComposer();
    });
    refs.body.addEventListener("input", () => {
      composerState.body = refs.body.value;
      refreshComposer();
    });

    /* Toolbar buttons */
    refs.modal.querySelectorAll("[data-composer-action]").forEach(() => {});
    refs.modal.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest("[data-composer-action]");
      if (!btn) return;
      const action = btn.dataset.composerAction;

      /* Toolbar formatting actions: dispatch via Composer.applyToolbar */
      const toolbarActions = ["bold","italic","strike","code","spoiler","h1","h2","h3","quote","ul","ol","hr","link","image","codeblock","table"];
      if (toolbarActions.includes(action)) {
        Composer.applyToolbar(action, refs.body);
        composerState.body = refs.body.value;
        refreshComposer();
        return;
      }

      if (action === "toggle-target") {
        const sub = btn.dataset.sub;
        const t = composerState.targets.find((x) => x.sub === sub);
        if (t) {
          t.checked = btn.checked;
          /* Auto-promote the first checked to seed if no seed currently. */
          if (t.checked && !composerState.targets.some((x) => x.seed && x.checked)) t.seed = true;
          if (!t.checked && t.seed) {
            t.seed = false;
            const next = composerState.targets.find((x) => x.checked);
            if (next) next.seed = true;
          }
        }
        refreshComposer();
        return;
      }
      if (action === "make-seed") {
        composerState.targets.forEach((x) => { x.seed = (x.sub === btn.dataset.sub); });
        refreshComposer();
        return;
      }
      if (action === "remove-target") {
        composerState.targets = composerState.targets.filter((x) => x.sub !== btn.dataset.sub);
        if (!composerState.targets.some((x) => x.seed)) {
          const first = composerState.targets.find((x) => x.checked);
          if (first) first.seed = true;
        }
        refreshComposer();
        return;
      }
      if (action === "sync-from-master") {
        const t = composerState.targets.find((x) => x.sub === btn.dataset.sub);
        if (t) { delete t.title; delete t.body; }
        refreshComposer();
        return;
      }
      if (action === "truncate-target") {
        Composer.truncateTargetToFit(composerState, btn.dataset.sub);
        /* Mode flipped to per-target — also flip the toggle UI. */
        refs.modeBtns.forEach((b) => {
          const on = b.dataset.composerMode === composerState.mode;
          b.classList.toggle("active", on);
          b.setAttribute("aria-checked", on ? "true" : "false");
        });
        refreshComposer();
        Util.toast("Trimmed body for r/" + btn.dataset.sub + " to fit 8 KB cap.", "ok");
        return;
      }
      if (action === "copy-image") {
        copyComposerImageToClipboard();
        return;
      }
      if (action === "copy-target-body") {
        copyTargetBodyAsRichText(btn.dataset.sub);
        return;
      }
      if (action === "open-submit") {
        /* Let the <a target="_blank"> default behavior do the work,
         * but mirror sub into composerState.targets for "active" hint. */
        return;
      }
    });

    /* Per-target editor inputs (event delegation for textarea/input) */
    refs.modal.addEventListener("input", (e) => {
      const el = e.target;
      const action = el.dataset && el.dataset.composerAction;
      if (action === "edit-target-title" || action === "edit-target-body") {
        const sub = el.dataset.sub;
        const t = composerState.targets.find((x) => x.sub === sub);
        if (!t) return;
        if (action === "edit-target-title") t.title = el.value.slice(0, Composer.LIMITS.titleMax);
        else t.body = el.value;
        /* Schedule a refresh but DON'T wholesale-rerender the targets
         * pane — that would steal focus. Update only counter / hint. */
        const urls = Composer.emitSubmitUrls(composerState);
        const u = urls.find((x) => x.sub === sub);
        if (u) {
          const row = el.closest(".composer-target-row");
          const counter = row && row.querySelector(".url-counter");
          if (counter) {
            counter.textContent = `${u.length} / 8000`;
            counter.classList.toggle("warn", u.warn === "soft");
            counter.classList.toggle("bad",  u.warn === "hard");
          }
        }
        if (composerSaveTimer) clearTimeout(composerSaveTimer);
        composerSaveTimer = setTimeout(() => Composer.saveDraft(composerState), 500);
      }
      if (action === "mark-posted-input") {
        /* Don't rerender on every keystroke; just hold the value. */
      }
    });

    /* Mark-posted submit handler */
    refs.modal.addEventListener("submit", (e) => {
      const form = e.target.closest && e.target.closest('[data-composer-action="mark-posted-form"]');
      if (!form) return;
      e.preventDefault();
      const sub = form.dataset.sub;
      const inp = form.querySelector('[data-composer-action="mark-posted-input"]');
      const url = inp ? inp.value.trim() : "";
      if (!url) { Util.toast("Paste the post URL first.", "error"); return; }
      const ids = Util.parseIdList(url);
      if (!ids.length) { Util.toast("Couldn't find a post ID in that URL.", "error"); return; }
      const t = composerState.targets.find((x) => x.sub === sub);
      if (t) {
        t.posted = true;
        t.postedUrl = url;
        t.postedAt = Date.now();
      }
      /* Add to the campaign for tracking. */
      if (composerState.campaignId && Campaigns && Campaigns.addPostIds) {
        const r = Campaigns.addPostIds(composerState.campaignId, ids);
        if (r) {
          Util.toast(`Marked posted in r/${sub} — added ${r.added} ID${r.added === 1 ? "" : "s"} to the campaign.`, "ok");
        }
      }
      Composer.saveDraft(composerState);
      refreshComposer();
      /* Bubble up to refresh the campaign-detail panel underneath. */
      try { refreshAllCampaignSummaries().catch(() => {}); } catch (_) {}
      try { if (composerState.campaignId) {
        const c = Campaigns.get(composerState.campaignId);
        if (c) openCampaign(c).catch(() => {});
      } } catch (_) {}
    });

    /* Mode toggle */
    refs.modeBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        composerState.mode = btn.dataset.composerMode;
        refs.modeBtns.forEach((b) => {
          const on = b === btn;
          b.classList.toggle("active", on);
          b.setAttribute("aria-checked", on ? "true" : "false");
        });
        refreshComposer();
      });
    });

    /* Pane toggle (mobile) */
    refs.paneBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const pane = btn.dataset.composerPane;
        document.body.classList.toggle("composer-pane-source", pane === "source");
        document.body.classList.toggle("composer-pane-preview", pane === "preview");
        refs.paneBtns.forEach((b) => {
          const on = b === btn;
          b.classList.toggle("active", on);
          b.setAttribute("aria-selected", on ? "true" : "false");
        });
      });
    });

    /* Link-mode + URL inputs */
    refs.linkMode.addEventListener("change", () => {
      composerState.isLinkPost = refs.linkMode.checked;
      refreshComposer();
    });
    refs.linkUrl.addEventListener("input", () => {
      composerState.linkUrl = refs.linkUrl.value;
      refreshComposer();
    });
    refs.imageUrl.addEventListener("input", () => {
      composerState.imageUrl = refs.imageUrl.value;
    });
    refs.imageInsert.addEventListener("click", () => {
      const url = composerState.imageUrl;
      if (!url) { Util.toast("Paste an image URL first.", "error"); return; }
      /* Insert as ![](url) at the body cursor. */
      refs.body.focus();
      const start = refs.body.selectionStart || refs.body.value.length;
      const before = refs.body.value.slice(0, start);
      const after = refs.body.value.slice(start);
      refs.body.value = before + "![](" + url + ")" + after;
      composerState.body = refs.body.value;
      refreshComposer();
    });

    /* Local image: file picker + drag-drop. Stored in memory only
     * (no IndexedDB persistence in v1 — would re-add complexity for
     * a feature most users won't use across sessions). */
    function attachImageBlob(blob) {
      if (!blob) return;
      composerImageBlob = blob;
      if (composerImageUrl) URL.revokeObjectURL(composerImageUrl);
      composerImageUrl = URL.createObjectURL(blob);
      refs.imageStatus.textContent = `Attached: ${blob.name || "image"} (${Math.round(blob.size / 1024)} KB) — use the "Copy img" button on each target row before posting.`;
      refs.imagePreview.hidden = false;
      refs.imagePreview.innerHTML = `<img src="${composerImageUrl}" alt="attached" /><span class="hint">Reddit's submit URL can't carry image bytes; the dashboard will copy this to your clipboard so you paste it on Reddit's submit page.</span>`;
      refreshComposer();
    }
    refs.imageFile.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f && f.type.startsWith("image/")) attachImageBlob(f);
    });
    if (refs.imageDrop) {
      refs.imageDrop.addEventListener("dragover", (e) => { e.preventDefault(); refs.imageDrop.classList.add("dragging"); });
      refs.imageDrop.addEventListener("dragleave", () => refs.imageDrop.classList.remove("dragging"));
      refs.imageDrop.addEventListener("drop", (e) => {
        e.preventDefault();
        refs.imageDrop.classList.remove("dragging");
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f && f.type.startsWith("image/")) attachImageBlob(f);
      });
    }

    /* AI prompt drawer */
    refs.aiCopy.addEventListener("click", async () => {
      const variants = Math.max(1, Math.min(5, Number(refs.aiVariants.value) || 1));
      const wordCount = String(refs.aiWords.value || "300-800").trim();
      const c = composerState.campaignId ? (Campaigns.get(composerState.campaignId)) : null;
      const subs = composerState.targets.filter((t) => t.checked).map((t) => t.sub);
      const prompt = Composer.buildAiPrompt(c ? c.name : "(unnamed)", composerState, subs, { variants, wordCount });
      try {
        await Util.copyToClipboard(prompt);
        Util.toast("AI prompt copied to clipboard.", "ok");
      } catch (_) {
        Util.toast("Couldn't copy — select & copy manually.", "error");
      }
    });
    refs.aiInsertReplace.addEventListener("click", () => {
      const text = refs.aiPaste.value;
      if (!text.trim()) { Util.toast("Paste the AI response first.", "error"); return; }
      const parsed = Composer.parseAiResponse(text);
      if (parsed.title) composerState.title = parsed.title;
      composerState.body = parsed.body || text;
      refs.title.value = composerState.title;
      refs.body.value = composerState.body;
      refs.aiPaste.value = "";
      refreshComposer();
      Util.toast("Inserted AI output.", "ok");
    });
    refs.aiInsertAppend.addEventListener("click", () => {
      const text = refs.aiPaste.value;
      if (!text.trim()) { Util.toast("Paste the AI response first.", "error"); return; }
      const parsed = Composer.parseAiResponse(text);
      const append = parsed.body || text;
      composerState.body = (composerState.body ? composerState.body + "\n\n" : "") + append;
      refs.body.value = composerState.body;
      refs.aiPaste.value = "";
      refreshComposer();
      Util.toast("Appended AI output.", "ok");
    });

    /* Bulk-select buttons. All / None / Unposted-only.
     *
     * Each one preserves an invariant: if any target is checked, ONE
     * of them is the seed. So "All" auto-promotes the first row to
     * seed if no current seed is checked, "None" clears the seed
     * along with everything else, and "Unposted only" promotes the
     * first unposted row to seed. */
    function ensureSeed() {
      const checked = composerState.targets.filter((t) => t.checked);
      const haveSeed = checked.some((t) => t.seed);
      if (!haveSeed && checked.length) {
        composerState.targets.forEach((t) => { t.seed = false; });
        checked[0].seed = true;
      }
      /* If no targets are checked, clear any orphan seed flag. */
      if (!checked.length) composerState.targets.forEach((t) => { t.seed = false; });
    }
    if (refs.selectAllBtn) refs.selectAllBtn.addEventListener("click", () => {
      composerState.targets.forEach((t) => { t.checked = true; });
      ensureSeed();
      refreshComposer();
    });
    if (refs.selectNoneBtn) refs.selectNoneBtn.addEventListener("click", () => {
      composerState.targets.forEach((t) => { t.checked = false; t.seed = false; });
      refreshComposer();
    });
    if (refs.selectUnpostedBtn) refs.selectUnpostedBtn.addEventListener("click", () => {
      composerState.targets.forEach((t) => { t.checked = !t.posted; });
      ensureSeed();
      refreshComposer();
    });

    /* Global "Copy as rich text" — bound here on the static button
     * (not via the targets-list event delegation, since this one
     * lives next to the body counter at the top of the editor and
     * doesn't need a sub argument). */
    if (refs.copyRichBtn) {
      refs.copyRichBtn.addEventListener("click", () => copyCanonicalBodyAsRichText());
    }

    /* Targets actions */
    refs.fromRecommended.addEventListener("click", () => {
      const c = composerState.campaignId ? Campaigns.get(composerState.campaignId) : null;
      const subs = composerSeedTargets(c);
      composerAddSubs(subs);
    });
    refs.fromActive.addEventListener("click", () => {
      composerAddSubs(Array.from(state.activeSubs || []));
    });
    refs.targetsAddBtn.addEventListener("click", () => {
      const v = (refs.targetsAdd.value || "").trim();
      if (!v) return;
      const subs = v.split(/[,;\s]+/).map((s) => s.replace(/^\/?r\//i, "").trim()).filter(Boolean);
      composerAddSubs(subs);
      refs.targetsAdd.value = "";
    });
    refs.targetsAdd.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); refs.targetsAddBtn.click(); }
    });

    /* Clear draft */
    refs.clearBtn.addEventListener("click", () => {
      if (!composerState || !composerState.campaignId) return;
      if (!confirm("Clear this draft? Cannot be undone.")) return;
      Composer.clearDraft(composerState.campaignId);
      composerState = Composer.defaultDraft(composerState.campaignId);
      refs.title.value = "";
      refs.body.value = "";
      refs.linkUrl.value = "";
      refs.imageUrl.value = "";
      refs.linkMode.checked = false;
      refreshComposer();
      Util.toast("Draft cleared.", "ok");
    });
  }

  function composerAddSubs(subs) {
    if (!composerState) return;
    const existing = new Set(composerState.targets.map((t) => t.sub.toLowerCase()));
    let added = 0;
    for (const raw of (subs || [])) {
      const s = String(raw || "").replace(/^\/?r\//i, "").trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (existing.has(k)) continue;
      existing.add(k);
      composerState.targets.push({
        sub: s,
        checked: true,
        seed: !composerState.targets.some((t) => t.seed && t.checked),
        posted: false,
      });
      added++;
    }
    if (added) {
      refreshComposer();
      Util.toast(`Added ${added} target${added === 1 ? "" : "s"}.`, "ok");
    } else {
      Util.toast("Already in targets.", "warn");
    }
  }

  /* Copy the attached local image to the clipboard so the user can
   * paste it into Reddit's image upload after the submit page opens.
   * Uses the modern ClipboardItem API; falls back to a download if
   * the browser refuses (e.g. older Safari). */
  /* Copy a target's effective body as rich text. Used when the
   * user is going to paste into Reddit's mobile app, which only
   * accepts rich-text input — markdown pasted as plain text shows
   * up literally with the asterisks visible.
   *
   * "Effective" body: per-target override (mode B), else canonical
   * body (mode A). Same resolution Composer.emitSubmitUrls uses.
   *
   * Renders the markdown via Composer.renderMarkdown (sanitized,
   * spoiler-aware, mention-linkified) and feeds both the HTML and
   * the original markdown source to Util.copyAsRichText. The
   * markdown source is the text/plain fallback so apps that
   * don't accept HTML still get the user's typed content. */
  /* Build the (html, plain) pair for a Reddit-mobile-app paste.
   * Single source of truth for both target-row and global copy
   * buttons so the format stays consistent.
   *
   * Renderer: Composer.renderForMobilePaste — uses ONLY the inline
   * tags Reddit's mobile app accepts on paste (<strong>, <em>,
   * <s>, <a>, <code>) inside <p>+<br>; lists/quotes/headings get
   * flattened with Unicode prefixes (•, 1., ▎) so the visual
   * structure survives the app's plain-text fallback path.
   *
   * Plain-text fallback: Composer.renderForMobilePastePlain —
   * the Unicode-prefixed text content, suitable for apps that
   * pick text/plain instead of text/html (some Slack channels,
   * iMessage, etc.). The user's original markdown source is
   * deliberately NOT used as the plain fallback because that
   * defeats the whole point — pasting `**bold**` into a non-
   * markdown editor shows literal asterisks. */
  function buildMobilePasteBlobs(body) {
    const html = (typeof Composer !== "undefined" && Composer.renderForMobilePaste)
      ? Composer.renderForMobilePaste(body)
      : ((typeof Composer !== "undefined" && Composer.renderMarkdown) ? Composer.renderMarkdown(body) : body);
    const plain = (typeof Composer !== "undefined" && Composer.renderForMobilePastePlain)
      ? Composer.renderForMobilePastePlain(body)
      : body;
    /* Wrap in a minimal HTML envelope. Some clipboard consumers
     * (older WebKit, certain Linux environments) prefer to see a
     * full document and ignore loose body fragments. The Reddit
     * mobile app accepts either, but the envelope is harmless and
     * improves cross-app paste reliability. */
    const wrapped = `<!DOCTYPE html><html><body>${html}</body></html>`;
    return { html: wrapped, plain };
  }

  async function copyTargetBodyAsRichText(sub) {
    if (!composerState) { Util.toast("Composer not open.", "error"); return; }
    const t = (composerState.targets || []).find((x) => x.sub === sub);
    if (!t) return;
    const body = (composerState.mode === "per-target" && t.body != null) ? t.body : composerState.body;
    if (!body || !body.trim()) {
      Util.toast("Body is empty — nothing to copy.", "error");
      return;
    }
    const { html, plain } = buildMobilePasteBlobs(body);
    const ok = await Util.copyAsRichText(html, plain);
    if (ok) {
      Util.toast(`Body for r/${sub} copied — paste in Reddit app's body. Bullets/headers preserved.`, "ok");
    } else {
      Util.toast("Couldn't copy. Long-press the body to copy manually.", "error");
    }
  }

  async function copyCanonicalBodyAsRichText() {
    if (!composerState) { Util.toast("Composer not open.", "error"); return; }
    const body = composerState.body;
    if (!body || !body.trim()) {
      Util.toast("Body is empty — nothing to copy.", "error");
      return;
    }
    const { html, plain } = buildMobilePasteBlobs(body);
    const ok = await Util.copyAsRichText(html, plain);
    if (ok) {
      Util.toast("Body copied — paste in Reddit app's body. Bullets/headers preserved via Unicode.", "ok");
    } else {
      Util.toast("Couldn't copy. Long-press the body to copy manually.", "error");
    }
  }

  async function copyComposerImageToClipboard() {
    if (!composerImageBlob) { Util.toast("No image attached.", "error"); return; }
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard && navigator.clipboard.write) {
        const item = new ClipboardItem({ [composerImageBlob.type]: composerImageBlob });
        await navigator.clipboard.write([item]);
        Util.toast("Image copied — paste it on Reddit's submit page.", "ok");
        return;
      }
    } catch (e) {
      console.warn("[composer] clipboard.write failed:", e && e.message);
    }
    /* Fallback: download the image so the user can attach it manually. */
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(composerImageBlob);
      a.download = composerImageBlob.name || "image";
      a.click();
      Util.toast("Clipboard refused — image downloaded; attach it manually.", "warn");
    } catch (_) {
      Util.toast("Couldn't copy or download the image.", "error");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
