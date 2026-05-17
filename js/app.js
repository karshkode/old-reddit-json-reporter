/* App orchestrator: wires UI events to fetchers + analysis + charts. */
(function () {
  const STORAGE_KEYS = {
    subs: "rj.subs",
    active: "rj.active",
    listing: "rj.listing",
    time: "rj.time",
    limit: "rj.limit",
  };

  const DEFAULT_SUBS = ["Political_Revolution", "50501"];

  /* `_runDiscover` is populated by bind() once the campaigns/discover
   * panel has been wired up. Other handlers (e.g. the post-row
   * "Make campaign" flow) can call it after creating + opening a new
   * campaign so the recommended-subreddits panel populates without an
   * extra user click. */
  let _runDiscover = null;

  const state = {
    knownSubs: [],
    activeSubs: new Set(),
    listing: "hot",
    timeWindow: "week",
    limit: 100,
    posts: [],
    sortKey: "score",
    sortDir: "desc",
    postIdFilter: [],
    searchQuery: "",
    detailCache: new Map(),
    campaignSummaries: {},
    lastTransport: null,
    lastErrors: [],
    /* deep analysis caches */
    subProfiles: {},
    timelineMode: "lines",  /* lines | stacked | density | total */
    timelineWindow: "7d",  /* 1d | 3d | 7d | 30d | 90d | 1y | all | auto */
    discoverStrict: true,    /* drop off-topic / generic subs in the discovery card */
    /* Last-rendered Analysis.detectCrossPosts result, keyed by
     * data-cp-index in the rendered cross-post rows so the
     * "+ Make campaign" button can resolve back to its group. */
    crossPosts: [],
    /* Posts table pagination + sub filter (Posts tab). */
    postsPage: 0,
    postsPageSize: 25,
    postsSubFilter: "",
    /* Cross-posts pagination + sub filter (Campaigns tab). */
    crossPostsPage: 0,
    crossPostsPageSize: 10,
    crossPostsSubFilter: "",
    /* Manually-chosen sphere keys to seed Discover with, on top of
     * Seeds.detectSpheres()'s auto-detection. Stored in localStorage
     * under "rj.activeSpheres". */
    activeSpheres: [],
    targetingFor: {
      ai: null,         // selected campaign id for the AI Insights playground
      campaigns: null,  // selected campaign id for the Campaigns tab card
    },
    /* monotonic counter — every refreshData() call increments it; running
     * fetches that observe a change discard their results so a fast user
     * tapping Refresh repeatedly doesn't get stale data piled on top. */
    fetchToken: 0,
    /* skip expensive renders (themes, profiles, charts) while a batch
     * fetch is still in progress — KPI + table render only. */
    rendering: { light: false },
  };

  function isMobile() {
    return window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
  }

  /* ---------- Persistence ---------- */

  function loadPersisted() {
    try {
      const subs = JSON.parse(localStorage.getItem(STORAGE_KEYS.subs) || "null");
      state.knownSubs = Array.isArray(subs) && subs.length ? subs : DEFAULT_SUBS.slice();
      const active = JSON.parse(localStorage.getItem(STORAGE_KEYS.active) || "null");
      state.activeSubs = new Set(Array.isArray(active) && active.length ? active : DEFAULT_SUBS.slice());
      state.listing = localStorage.getItem(STORAGE_KEYS.listing) || "hot";
      state.timeWindow = localStorage.getItem(STORAGE_KEYS.time) || "week";
      state.limit = Number(localStorage.getItem(STORAGE_KEYS.limit)) || 100;
      try {
        const raw = localStorage.getItem("rj.activeSpheres");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) state.activeSpheres = parsed.filter((k) => typeof k === "string");
        }
      } catch (_) {}
    } catch (_) {
      state.knownSubs = DEFAULT_SUBS.slice();
      state.activeSubs = new Set(DEFAULT_SUBS);
    }
  }

  function persist() {
    localStorage.setItem(STORAGE_KEYS.subs, JSON.stringify(state.knownSubs));
    localStorage.setItem(STORAGE_KEYS.active, JSON.stringify(Array.from(state.activeSubs)));
    localStorage.setItem(STORAGE_KEYS.listing, state.listing);
    localStorage.setItem(STORAGE_KEYS.time, state.timeWindow);
    localStorage.setItem(STORAGE_KEYS.limit, String(state.limit));
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

  /* ---------- Filter drawer ---------- */

  /* Filter drawer visibility.
   * Mobile uses an .expanded class on .controls (default hidden);
   * desktop uses .collapsed (default shown) so a single toggle button
   * works in both worlds without breaking either default. */
  function setControlsExpanded(expanded) {
    const controls = document.getElementById("controls");
    const toggle = document.getElementById("filters-toggle");
    if (!controls) return;
    if (isMobile()) {
      controls.classList.toggle("expanded", expanded);
      controls.classList.remove("collapsed");
    } else {
      controls.classList.toggle("collapsed", !expanded);
      controls.classList.remove("expanded");
    }
    if (toggle) {
      toggle.classList.toggle("expanded", expanded);
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
  }

  /* Helper for closeOnSelect callers — checks the current visibility
   * of the controls drawer regardless of which class drives it. */
  function controlsAreVisible() {
    const controls = document.getElementById("controls");
    if (!controls) return false;
    if (isMobile()) return controls.classList.contains("expanded");
    return !controls.classList.contains("collapsed");
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
    UI.renderKpis(agg);
    renderPostsView();
  }

  function rerenderAll() {
    if (state.rendering.light) return rerenderLight();

    const posts = filteredPosts();
    const agg = Analysis.aggregate(posts);
    const sentiment = Analysis.aggregateSentiment(posts);
    const themes = Analysis.themes(posts);
    state.subProfiles = Analysis.subredditProfiles(posts);
    /* Attach an engagement-trend slope per sub so recommendTargets can
     * fold "trending up / down / flat" into its composite score. */
    if (state.subProfiles && Object.keys(state.subProfiles).length) {
      const bySub = {};
      for (const p of posts) {
        const k = (p.subreddit || "").toLowerCase();
        if (!k) continue;
        (bySub[k] = bySub[k] || []).push(p);
      }
      for (const [k, list] of Object.entries(bySub)) {
        if (state.subProfiles[k]) {
          state.subProfiles[k]._trend = Analysis.engagementTrend(list);
        }
      }
    }

    UI.renderKpis(agg);
    renderPostsView();
    refreshSubFilterDropdowns();

    if (window.Chart) {
      /* Each chart wrapped so one bad render (e.g. zero-data state during
       * an in-progress fetch, or a browser without canvas support) can't
       * take down the whole rerender path — which would otherwise prevent
       * post-init steps like wireSyncSession from ever running. */
      function safeChart(label, fn) {
        try { fn(); } catch (err) { console.warn(`[charts] ${label}:`, err && err.message); }
      }
      safeChart("timeline", () => {
        const timelineData = Analysis.bucketByTimePerSub(posts, { window: state.timelineWindow });
        Charts.timeline("chart-timeline", timelineData, { mode: state.timelineMode });
        const hintEl = document.getElementById("timeline-hint");
        if (hintEl) {
          const subsCount = timelineData.subs.length;
          const modeLabel = state.timelineMode === "total" ? "All subs combined" : state.timelineMode === "stacked" ? "Stacked by sub" : state.timelineMode === "density" ? "Each sub at its own peak (%)" : "One line per sub";
          const winLabel = state.timelineWindow === "all" ? "all loaded data" : state.timelineWindow === "auto" ? `auto window (${timelineData.windowLabel})` : `last ${state.timelineWindow}`;
          const droppedNote = timelineData.droppedCount ? ` · ${timelineData.droppedCount} older post${timelineData.droppedCount === 1 ? "" : "s"} hidden` : "";
          hintEl.textContent = `${modeLabel} · ${winLabel} · ${timelineData.bucketLabel} buckets${subsCount ? ` · ${subsCount} sub${subsCount === 1 ? "" : "s"}` : ""}${droppedNote}`;
        }
      });
      safeChart("scatter", () => Charts.scatter("chart-scatter", posts));
      safeChart("subCompare", () => Charts.subCompare("chart-sub-compare", agg));
      safeChart("histogram", () => Charts.histogram("chart-hist", Analysis.scoreHistogram(posts, 12)));
      safeChart("hourHeat", () => Charts.hourHeat("chart-hour-heat", agg));
      safeChart("dow", () => Charts.dow("chart-dow", agg));
      safeChart("velocity", () => Charts.velocity("chart-velocity", posts));
      safeChart("sentiment", () => Charts.sentiment("chart-sentiment", sentiment));
    }

    UI.renderKeywords(Analysis.extractKeywords(posts, 30));
const crossPosts = Analysis.detectCrossPosts(posts);
    /* Tag each group with its absolute index so render-after-filter/page
     * still resolves back to state.crossPosts[idx] from the click handler. */
    crossPosts.forEach((g, i) => { g._origIndex = i; });
    state.crossPosts = crossPosts;
    let xpFiltered = crossPosts;
    if (state.crossPostsSubFilter) {
      const sub = state.crossPostsSubFilter.toLowerCase();
      xpFiltered = xpFiltered.filter((g) => g.subs.includes(sub));
    }
    UI.renderCrossPosts(xpFiltered, {
      page: state.crossPostsPage,
      pageSize: state.crossPostsPageSize === "all" ? "all" : Number(state.crossPostsPageSize),
    });
    UI.renderPagination("crossposts-pagination", {
      page: state.crossPostsPage,
      totalItems: xpFiltered.length,
      pageSize: state.crossPostsPageSize === "all" ? "all" : Number(state.crossPostsPageSize),
      onChange: (newPage) => { state.crossPostsPage = newPage; rerenderAll(); },
    });
    UI.renderRecommendations(Analysis.recommendations(agg, sentiment, posts));
    UI.renderNarrative(Analysis.narrative(agg, sentiment, Array.from(state.activeSubs)));
    UI.renderThemes(themes);
    UI.renderSubProfiles(state.subProfiles);

    /* Refresh both targeting playgrounds whenever the dataset changes. */
  }

  /* ---------- Data fetch ---------- */

  async function refreshData(force) {
    if (!state.activeSubs.size) {
      state.posts = [];
      Util.setStatus("No active subreddits selected.", "err");
      Util.hideProgress();
      hideBanner();
      rerenderAll();
      return;
    }
    if (force) Reddit.clearCache();

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
        Util.toast(`r/${sub}: ${err.message}`, "error");
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

    state.posts = Util.uniqBy(collected, (p) => p.id);
    state.lastTransport = Reddit._lastTransport || state.lastTransport;
    state.rendering.light = false;
    Util.hideProgress(`Loaded ${state.posts.length} posts from ${subs.length} sub${subs.length > 1 ? "s" : ""}${errors ? ` (${errors} error${errors > 1 ? "s" : ""})` : ""}`);

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
    UI.activateTab("posts");
    const card = document.getElementById("post-detail");
    const body = document.getElementById("post-detail-body");
    card.hidden = false;
    body.innerHTML = `<div class="empty"><div class="skeleton" style="margin-bottom:6px"></div><div class="skeleton" style="margin-bottom:6px;width:80%"></div><div class="skeleton" style="width:60%"></div></div>`;
    try {
      let data = state.detailCache.get(post.id);
      if (!data) {
        data = await Reddit.fetchPostWithComments(post.id, { commentLimit: 50 });
        if (data) state.detailCache.set(post.id, data);
      }
      if (!data) throw new Error("post not found");
      UI.renderPostDetail(data.post, data.comments);
    } catch (err) {
      body.innerHTML = `<div class="empty">Failed to load post: ${Util.escapeHtml(err.message)}</div>`;
    }
  }

  /* ---------- Campaigns ---------- */

  async function refreshAllCampaignSummaries() {
    const list = Campaigns.list();
    if (!list.length) {
      state.campaignSummaries = {};
      UI.renderCampaignList([], {}, openCampaign);
      populateTargetingSelectors();
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
    UI.renderCampaignList(Campaigns.list(), summaries, openCampaign);
    populateTargetingSelectors();

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
    UI.renderCampaignList(Campaigns.list(), summaries, openCampaign);
    populateTargetingSelectors();

    const dur = Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0));
    console.log(`[campaigns] refreshed ${list.length} in ${dur}ms`);
  }

  async function openCampaign(campaign) {
    const card = document.getElementById("campaign-detail");
    const body = document.getElementById("campaign-detail-body");
    card.hidden = false;
    state.openCampaignId = campaign.id;

    /* Auto-repair: if the campaign was saved with raw mobile-share URLs in
     * its postIds (older code paths did this), resolve them now and rewrite
     * the stored campaign. Future opens will then hit the fast path. */
    const shareEntries = (campaign.postIds || []).filter((s) => Util.isShareUrl(s));
    if (shareEntries.length) {
      try {
        body.innerHTML = `<div class="empty">Repairing ${shareEntries.length} mobile-share URL${shareEntries.length === 1 ? "" : "s"} (one-time)…<div class="hint" style="margin-top:6px">Following Reddit redirects to extract canonical post IDs.</div></div>`;
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
            /* Keep the original share URL so the user can see what failed
             * in the missing list and try again later. */
            newPostIds.push(old);
          }
        }
        Campaigns.update(campaign.id, { postIds: newPostIds });
        campaign = Campaigns.get(campaign.id);
        if (failed.length) {
          Util.toast(`Repaired ${fixed} of ${shareEntries.length} share URLs (${failed.length} failed). The rest stay flagged in the missing list — tap Refresh to try again.`, "error");
        } else {
          Util.toast(`Repaired ${fixed} share URL${fixed === 1 ? "" : "s"}.`, "ok");
        }
        console.log(`[openCampaign] repaired ${fixed}/${shareEntries.length} share URLs in "${campaign.name}"`);
      } catch (err) {
        console.warn(`[openCampaign] share-URL repair failed:`, err && err.message);
        Util.toast(`Couldn't repair share URLs: ${(err && err.message) || err}`, "error");
      }
    }

    /* Instant first paint using whatever we already have locally. */
    let localAgg = null;
    try {
      localAgg = await Campaigns.fetchAggregated(campaign, { fromPosts: state.posts, skipNetwork: true });
      const deepLocal = computeCampaignDeep(campaign, localAgg);
      UI.renderCampaignDetail(campaign, localAgg, deepLocal);
      const inlineLocal = document.getElementById("campaign-detail-targets");
      if (inlineLocal) UI.renderTargeting(campaign, deepLocal ? deepLocal.targets : [], inlineLocal, { heading: false });
    } catch (_) {
      body.innerHTML = `<div class="empty"><div class="skeleton" style="margin-bottom:6px"></div><div class="skeleton" style="margin-bottom:6px;width:80%"></div><div class="skeleton" style="width:60%"></div></div>`;
    }

    /* Network pass: fetches anything we couldn't satisfy locally. */
    try {
      const agg = await Campaigns.fetchAggregated(campaign, { fromPosts: state.posts });
      state.campaignSummaries[campaign.id] = agg;

      const deep = computeCampaignDeep(campaign, agg);
      UI.renderCampaignDetail(campaign, agg, deep);
      UI.renderCampaignList(Campaigns.list(), state.campaignSummaries, openCampaign);

      const inlineEl = document.getElementById("campaign-detail-targets");
      if (inlineEl) UI.renderTargeting(campaign, deep ? deep.targets : [], inlineEl, { heading: false });

      console.log(`[openCampaign] ${campaign.name}: local=${agg.resolvedFromLocal} network=${agg.resolvedFromNetwork} missing=${agg.missing.length}`);
    } catch (err) {
      const msg = (err && err.message) || String(err);
      console.warn(`[openCampaign] ${campaign.name} network refresh failed:`, msg);
      /* Keep the local-only render if we have it. Otherwise show retry. */
      if (localAgg && localAgg.posts.length) {
        Util.toast(`Couldn't refresh "${campaign.name}" from Reddit (${msg.slice(0, 60)}). Showing locally-resolved posts.`, "error");
      } else {
        body.innerHTML = `
          <div class="empty">
            <div>Couldn't fetch campaign data: <strong>${Util.escapeHtml(msg)}</strong></div>
            <div class="hint" style="margin-top:6px">All public CORS proxies failed for this batch. Try switching <strong>Data source</strong> in the topbar, or wait a moment for the rate limit to clear.</div>
            <div style="margin-top:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
              <button class="btn primary small" id="campaign-retry-btn">Retry</button>
              <button class="btn small" id="campaign-retry-clear-btn">Clear cache &amp; retry</button>
            </div>
          </div>
        `;
        const retry = document.getElementById("campaign-retry-btn");
        if (retry) retry.addEventListener("click", () => openCampaign(campaign));
        const retryClear = document.getElementById("campaign-retry-clear-btn");
        if (retryClear) retryClear.addEventListener("click", () => {
          Reddit.clearCache();
          openCampaign(campaign);
        });
      }
    }
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
    const targets = Analysis.recommendTargets(profile, state.subProfiles, { limit: 8 });
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
      parts.push(`<p>Posts in this campaign cluster around <strong>${String(profile.bestHour).padStart(2, "0")}:00 ${Util.escapeHtml(Util.getTzLabel())}</strong> (best avg score, in your local timezone). Consider matching timing on future cross-posts.</p>`);
    }

    if (comparison && comparison.insights && comparison.insights.length) {
      parts.push(`<p><strong>Why some posts win:</strong> ${comparison.insights[0]}</p>`);
    }

    return parts.join("\n");
  }

  /* ---------- Targeting selectors ---------- */

  function populateTargetingSelectors() {
    const campaigns = Campaigns.list();
    for (const id of ["discover-campaign"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      const previous = el.value;
      el.innerHTML = "";
      if (!campaigns.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(no campaigns saved — create one on the Campaigns tab)";
        el.appendChild(opt);
        continue;
      }
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "— pick a campaign —";
      el.appendChild(placeholder);
      for (const c of campaigns) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.name;
        el.appendChild(opt);
      }
      if (previous && campaigns.some((c) => c.id === previous)) el.value = previous;
    }
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
    const targets = Analysis.recommendTargets(profile, state.subProfiles, { limit: 10 });
    UI.renderTargeting(campaign, targets, out, { heading: true });
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
    for (const c of all) byCanonical.set(c.canonical, c);

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

  /* Best-effort clipboard write — falls back to a hidden textarea if
   * the Async Clipboard API isn't available (e.g. http://localhost in
   * some browsers). */
  async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
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
      /* Strip the session= fragment so a reload doesn't re-prompt. */
      try {
        const url = new URL(location.href);
        url.hash = url.hash.replace(/(?:^|[#&])session=[^&]+/, "").replace(/^#&/, "#").replace(/^#$/, "");
        history.replaceState(null, "", url.pathname + url.search + (url.hash || ""));
      } catch (_) {}
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

    /* On init: if URL has a session payload, surface a banner. */
    try {
      const found = Sync.parseHashPayload();
      if (found && found.payload) {
        showSessionImportBanner(found.payload, found.encoded);
      }
    } catch (err) {
      console.warn("[sync] hash parse failed:", err && err.message);
    }

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
        const url = Sync.toShareUrl();
        const ok = await copyToClipboard(url);
        const len = url.length;
        if (ok) {
          setSyncStatus(`Share link copied (${len.toLocaleString()} chars). Paste it on another device to import this session.`, "ok");
          Util.toast("Share link copied to clipboard.", "ok");
        } else {
          setSyncStatus("Could not access clipboard — link shown below; long-press to copy.", "err");
          /* Fall back to showing the URL in the import textarea so the
           * user can long-press it on iOS. */
          if (ta) ta.value = url;
          if (panel) panel.hidden = false;
        }
        if (len > 30000) {
          setSyncStatus("Heads up: this share link is long (" + len.toLocaleString() + " chars). Some chat apps truncate URLs over ~30k characters — Download JSON is more reliable for big sessions.", "warn");
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

    if (applyBtn && ta) applyBtn.addEventListener("click", () => {
      const raw = (ta.value || "").trim();
      if (!raw) { setImportStatus("Paste a share link or session JSON first.", "err"); return; }
      let payload = null;
      /* Try URL form first. */
      const m = raw.match(/[#&?]session=([^&\s]+)/);
      if (m) {
        payload = Sync.decode(m[1]);
      }
      /* Else try base64 alone. */
      if (!payload && /^[-_A-Za-z0-9]+$/.test(raw) && raw.length > 40) {
        payload = Sync.decode(raw);
      }
      /* Else try JSON. */
      if (!payload) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.app === "old-reddit-json-reporter") payload = parsed;
        } catch (_) {}
      }
      if (!payload) { setImportStatus("Couldn't recognise that as a session. Paste a share link, a JSON blob, or upload a downloaded file.", "err"); return; }
      try {
        const stats = Sync.applyPayload(payload, { mode: mergeBox && mergeBox.checked ? "merge" : "replace" });
        loadPersisted();
        renderChips();
        rerenderAll();
        refreshAllCampaignSummaries();
        if (!mergeBox || !mergeBox.checked) refreshData(true);
        setImportStatus(`Imported · ${stats.campaignsAdded} campaign${stats.campaignsAdded === 1 ? "" : "s"} added (${stats.mode}). Active subs: ${stats.activeSubs}.`, "ok");
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
    const transportSelectMobile = document.getElementById("transport-select-mobile");
    populateTransportSelect(transportSelect);
    populateTransportSelect(transportSelectMobile);

    function onTransportChange(e) {
      const v = e.target.value;
      Reddit.setTransport(v);
      if (transportSelect && transportSelect !== e.target) transportSelect.value = v;
      if (transportSelectMobile && transportSelectMobile !== e.target) transportSelectMobile.value = v;
      Reddit.clearCache();
      Util.toast(`Data source: ${v}`, "ok");
      refreshData(true);
    }
    if (transportSelect) transportSelect.addEventListener("change", onTransportChange);
    if (transportSelectMobile) transportSelectMobile.addEventListener("change", onTransportChange);

    Reddit.onTransportSuccess = function (name) { state.lastTransport = name; };

    const filtersToggle = document.getElementById("filters-toggle");
    if (filtersToggle) {
      filtersToggle.addEventListener("click", () => {
        /* Use controlsAreVisible() so toggling works on both viewports
         * — mobile uses .expanded, desktop uses .collapsed. */
        setControlsExpanded(!controlsAreVisible());
      });
    }

    document.getElementById("refresh-btn").addEventListener("click", () => refreshData(true));
    const clearBtn = document.getElementById("clear-cache-btn");
    if (clearBtn) clearBtn.addEventListener("click", () => { Reddit.clearCache(); Util.toast("Cache cleared", "ok"); });
    const clearBtnMobile = document.getElementById("clear-cache-btn-mobile");
    if (clearBtnMobile) clearBtnMobile.addEventListener("click", () => { Reddit.clearCache(); Util.toast("Cache cleared", "ok"); });

    document.getElementById("listing-select").addEventListener("change", (e) => {
      state.listing = e.target.value; persist(); refreshData();
    });
    document.getElementById("time-select").addEventListener("change", (e) => {
      state.timeWindow = e.target.value; persist(); refreshData();
    });
    document.getElementById("limit-select").addEventListener("change", (e) => {
      state.limit = Number(e.target.value); persist(); refreshData();
    });

    document.getElementById("listing-select").value = state.listing;
    document.getElementById("time-select").value = state.timeWindow;
    document.getElementById("limit-select").value = String(state.limit);

    document.getElementById("add-sub-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("add-sub-input");
      const name = Util.normalizeSubName(input.value);
      if (!name) return;
      if (!state.knownSubs.includes(name)) state.knownSubs.push(name);
      state.activeSubs.add(name);
      input.value = "";
      persist();
      renderChips();
      refreshData();
    });

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

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => UI.activateTab(tab.dataset.tab));
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

    document.querySelectorAll("[data-collapsible]").forEach((card) => {
      if (card.hasAttribute("data-collapsed-default")) card.classList.add("collapsed");
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

    /* Discovery strictness toggle */
    document.querySelectorAll("#discover-card .discover-mode button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = btn.dataset.strict === "1";
        if (s === state.discoverStrict) return;
        state.discoverStrict = s;
        document.querySelectorAll("#discover-card .discover-mode button").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", b === btn ? "true" : "false");
        });
      });
    });

    document.querySelectorAll("#posts-table thead th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const k = th.dataset.sort;
        if (state.sortKey === k) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        else { state.sortKey = k; state.sortDir = (k === "title" || k === "author" || k === "id" || k === "subreddit") ? "asc" : "desc"; }
        state.postsPage = 0;
        rerenderAll();
        syncMobileSort();
      });
    });

    const mobileSort = document.getElementById("mobile-sort");
    if (mobileSort) {
      mobileSort.addEventListener("change", (e) => {
        const [k, d] = e.target.value.split(":");
        state.sortKey = k;
        state.sortDir = d === "asc" ? "asc" : "desc";
        rerenderAll();
      });
    }

    function syncMobileSort() {
      if (mobileSort) {
        const v = `${state.sortKey}:${state.sortDir}`;
        const has = Array.from(mobileSort.options).some((o) => o.value === v);
        if (has) mobileSort.value = v;
      }
    }
    syncMobileSort();

    document.getElementById("close-detail").addEventListener("click", UI.hidePostDetail);

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

        UI.renderCampaignList(Campaigns.list(), state.campaignSummaries, openCampaign);
        populateTargetingSelectors();

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

    document.getElementById("campaign-close").addEventListener("click", UI.hideCampaignDetail);
    document.getElementById("campaign-refresh").addEventListener("click", () => {
      const id = state.openCampaignId;
      if (!id) return;
      Reddit.clearCache();
      const c = Campaigns.get(id);
      if (c) openCampaign(c);
    });
    document.getElementById("campaign-delete").addEventListener("click", () => {
      const id = state.openCampaignId;
      if (!id) return;
      if (!confirm("Delete this campaign? Stored locally only.")) return;
      Campaigns.remove(id);
      UI.hideCampaignDetail();
      refreshAllCampaignSummaries();
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
          UI.activateTab("campaigns");
          UI.renderCampaignList(Campaigns.list(), state.campaignSummaries, openCampaign);
          populateTargetingSelectors();
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
    const postsTbodyEl = document.getElementById("posts-tbody");
    if (postsTbodyEl) {
      postsTbodyEl.addEventListener("click", (e) => {
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
          postsTbodyEl.querySelectorAll(".post-make-form-row").forEach((r) => {
            const prev = r.previousElementSibling;
            if (prev && prev !== tr) UI.dismissPostMakeCampaignForm(prev);
          });
          UI.renderPostMakeCampaignForm(tr, post);
          return;
        }

        const cancelBtn = e.target.closest && e.target.closest('[data-action="cancel-make-campaign-from-post"]');
        if (cancelBtn) {
          e.preventDefault();
          e.stopPropagation();
          const formRow = cancelBtn.closest(".post-make-form-row");
          const tr = formRow && formRow.previousElementSibling;
          if (tr) UI.dismissPostMakeCampaignForm(tr);
          return;
        }
      });

      postsTbodyEl.addEventListener("submit", async (e) => {
        const form = e.target.closest && e.target.closest(".post-make-form");
        if (!form) return;
        e.preventDefault();
        e.stopPropagation();
        await handleMakeCampaignFromPost(form);
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

        UI.activateTab("campaigns");
        UI.renderCampaignList(Campaigns.list(), state.campaignSummaries, openCampaign);
        populateTargetingSelectors();
        refreshAllCampaignSummaries().catch((err) => console.warn("[post->campaign] summary refresh failed:", err && err.message));
        await openCampaign(c);

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

    /* Inline add-posts form + per-row remove button inside the campaign
     * detail panel. We use event delegation on the body so the handlers
     * survive every re-render. */
    const campaignDetailBody = document.getElementById("campaign-detail-body");

    if (campaignDetailBody) {
      /* Live paste preview under the add-posts textarea. */
      campaignDetailBody.addEventListener("input", (e) => {
        const ta = e.target.closest && e.target.closest('[data-role="add-posts-textarea"]');
        if (!ta) return;
        const form = ta.closest(".add-posts-form");
        const prev = form && form.querySelector('[data-role="add-posts-preview"]');
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

      campaignDetailBody.addEventListener("paste", (e) => {
        const ta = e.target.closest && e.target.closest('[data-role="add-posts-textarea"]');
        if (!ta) return;
        setTimeout(() => ta.dispatchEvent(new Event("input", { bubbles: true })), 0);
      });

      /* Click delegation: Add posts / Remove from campaign. */
      campaignDetailBody.addEventListener("click", async (e) => {
        const addBtn = e.target.closest && e.target.closest('[data-action="add-posts"]');
        const rmBtn = e.target.closest && e.target.closest('[data-action="remove-post"]');

        if (addBtn) {
          e.preventDefault();
          await handleAddPostsToOpenCampaign(addBtn);
          return;
        }
        if (rmBtn) {
          e.preventDefault();
          handleRemovePostFromOpenCampaign(rmBtn);
          return;
        }
      });
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

        if (resolveFailed.length) {
          Util.toast(`Added ${result.added} post${result.added === 1 ? "" : "s"} (${resolveFailed.length} share URL${resolveFailed.length === 1 ? "" : "s"} failed)`, "error");
        } else if (result.added === 0) {
          Util.toast("Those posts are already in the campaign.", "ok");
        } else {
          Util.toast(`Added ${result.added} post${result.added === 1 ? "" : "s"} to "${result.campaign.name}".`, "ok");
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
      /* Optimistically hide the row immediately for snappy feedback. */
      const row = btn.closest(".campaign-post-row");
      if (row) row.style.display = "none";
      /* Then re-render fully to update KPIs / progress bars / deep analysis. */
      openCampaign(result.campaign).catch(() => {});
      refreshAllCampaignSummaries().catch(() => {});
    }


    /* Close filters drawer when user finishes a filter action on mobile */
    /* Auto-hide the filter drawer after the user picks a listing /
     * window / limit value on EITHER viewport. Mobile already had this;
     * desktop now matches. Skipped if the drawer is already hidden so
     * the toggle button can stay in its current visual state. */
    const closeOnSelect = (el) => {
      if (!el) return;
      el.addEventListener("change", () => {
        if (controlsAreVisible()) setControlsExpanded(false);
      });
    };
    /* Posts tab — title search input (mirrors the global search input). */
    const postsTitleSearch = document.getElementById("posts-title-search");
    if (postsTitleSearch) {
      const globalSearch = document.getElementById("search-input");
      if (globalSearch) postsTitleSearch.value = globalSearch.value || "";
      const debouncedTabSearch = Util.debounce(() => { rerenderLight(); }, 200);
      postsTitleSearch.addEventListener("input", (e) => {
        state.searchQuery = e.target.value.trim();
        state.postsPage = 0;
        if (globalSearch && globalSearch.value !== e.target.value) globalSearch.value = e.target.value;
        debouncedTabSearch();
      });
    }

    /* Posts tab — sub filter + per-page. */
    const postsSubSel = document.getElementById("posts-sub-filter");
    if (postsSubSel) postsSubSel.addEventListener("change", (e) => {
      state.postsSubFilter = e.target.value || "";
      state.postsPage = 0;
      rerenderLight();
    });
    const postsPageSizeSel = document.getElementById("posts-page-size");
    if (postsPageSizeSel) postsPageSizeSel.addEventListener("change", (e) => {
      state.postsPageSize = e.target.value === "all" ? "all" : Number(e.target.value) || 25;
      state.postsPage = 0;
      rerenderLight();
    });

    /* Cross-posts (Campaigns tab) — sub filter + per-page. */
    const xpSubSel = document.getElementById("crossposts-sub-filter");
    if (xpSubSel) xpSubSel.addEventListener("change", (e) => {
      state.crossPostsSubFilter = e.target.value || "";
      state.crossPostsPage = 0;
      rerenderAll();
    });
    const xpPageSizeSel = document.getElementById("crossposts-page-size");
    if (xpPageSizeSel) xpPageSizeSel.addEventListener("change", (e) => {
      state.crossPostsPageSize = e.target.value === "all" ? "all" : Number(e.target.value) || 10;
      state.crossPostsPage = 0;
      rerenderAll();
    });

    closeOnSelect(document.getElementById("listing-select"));
    closeOnSelect(document.getElementById("time-select"));
    closeOnSelect(document.getElementById("limit-select"));

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

    /* ------ Discover similar subreddits ------ */
    const discoverBtn = document.getElementById("discover-run");
    const discoverSel = document.getElementById("discover-campaign");
    const discoverResults = document.getElementById("discover-results");
    const discoverStatus = document.getElementById("discover-status");

    function setDiscoverStatus(text, kind) {
      if (!discoverStatus) return;
      discoverStatus.style.display = text ? "block" : "none";
      discoverStatus.className = "meta " + (kind || "");
      discoverStatus.textContent = text || "";
    }

    async function runDiscover() {
      try {
        if (!discoverSel || !discoverSel.value) {
          setDiscoverStatus("Pick a campaign first.", "err");
          return;
        }
        const campaign = Campaigns.get(discoverSel.value);
        if (!campaign) { setDiscoverStatus("Campaign not found.", "err"); return; }

        const summary = state.campaignSummaries[campaign.id];
        if (!summary || !summary.posts || !summary.posts.length) {
          setDiscoverStatus(`"${campaign.name}" has no resolved posts. Open it on the Campaigns tab and tap Refresh first.`, "err");
          discoverResults.innerHTML = "";
          return;
        }
        const profile = Analysis.campaignProfile(summary.posts, campaign);
        const queries = Analysis.buildDiscoveryQuerySet(profile, 6);
        if (!queries.length) {
          setDiscoverStatus("Not enough campaign content to derive search queries.", "err");
          return;
        }

        if (discoverBtn) { discoverBtn.disabled = true; discoverBtn.textContent = "Searching…"; }
        setDiscoverStatus(`Running ${queries.length} angle${queries.length === 1 ? "" : "s"}: ${queries.join(" · ").slice(0, 100)}…`);
        discoverResults.innerHTML = `<div class="empty"><div class="skeleton" style="margin-bottom:6px"></div><div class="skeleton" style="margin-bottom:6px;width:80%"></div><div class="skeleton" style="width:60%"></div></div>`;
        /* 4 phases: subreddit search, post mining, catalog seeding, scoring.
         * Allocate weights so the bar feels natural. */
        const PHASE_WEIGHTS = { search: 0.40, posts: 0.25, catalog: 0.25, score: 0.10 };
        let progressPct = 2;
        Util.setProgress(progressPct, `Searching Reddit · 0 / ${queries.length} angles`);

        const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());

        /* 1. Multi-query subreddit search — each top phrase / keyword is
         *    its own query. We tally how many queries each sub appeared
         *    in so the recommender can boost cross-query matches. */
        const subResults = new Map();   // canonical -> { candidate, hits }
        const queryHitsByName = {};
        let queriesDone = 0;
        await Util.pmap(queries, 2, async (q) => {
          try {
            const r = await Reddit.searchSubreddits(q, { limit: 12 });
            for (const sr of r) {
              const k = (sr.display_name || "").toLowerCase();
              if (!k) continue;
              if (!subResults.has(k)) subResults.set(k, { candidate: sr, hits: 0 });
              subResults.get(k).hits++;
              queryHitsByName[k] = (queryHitsByName[k] || 0) + 1;
            }
          } catch (e) {
            console.warn(`[discover] sub-search "${q}" failed:`, e && e.message);
          } finally {
            queriesDone++;
            progressPct = 2 + PHASE_WEIGHTS.search * 100 * (queriesDone / queries.length);
            Util.setProgress(progressPct, `Searching Reddit · ${queriesDone} / ${queries.length} angles · ${subResults.size} subs found`);
          }
        });

        /* 2. Post mining — search /search.json for posts that mention the
         *    campaign keywords, then collect distinct subreddits those
         *    posts live in. This finds niche / active communities the
         *    /subreddits/search endpoint never surfaces. */
        const postQuery = (profile.keywords || []).slice(0, 4).map((k) => k.word).join(" ");
        const postHitsByName = {};
        let postHitsTotal = 0;
        progressPct = 2 + PHASE_WEIGHTS.search * 100;
        Util.setProgress(progressPct, `Mining recent hot posts for sub mentions…`);
        if (postQuery) {
          try {
            const posts = await Reddit.searchPosts(postQuery, { limit: 75, sort: "top", t: "month" });
            postHitsTotal = posts.length;
            const subFromPosts = new Map();
            for (const p of posts) {
              const k = (p.subreddit || "").toLowerCase();
              if (!k) continue;
              subFromPosts.set(k, (subFromPosts.get(k) || 0) + 1);
            }
            for (const [k, v] of subFromPosts.entries()) postHitsByName[k] = v;

            /* Fetch about info for sub names that didn't show up in
             * /subreddits/search but were mined from posts. Concurrency 3,
             * skip when we already have it. */
            const newSubs = Array.from(subFromPosts.keys())
              .filter((k) => !subResults.has(k))
              .sort((a, b) => (subFromPosts.get(b) || 0) - (subFromPosts.get(a) || 0))
              .slice(0, 12);
            let aboutDone = 0;
            const aboutTotal = newSubs.length || 1;
            await Util.pmap(newSubs, 3, async (sub) => {
              try {
                const about = await Reddit.fetchSubredditAbout(sub);
                if (about && about.display_name) {
                  const k = about.display_name.toLowerCase();
                  if (!subResults.has(k)) subResults.set(k, { candidate: about, hits: 0 });
                }
              } catch (_) {}
              finally {
                aboutDone++;
                progressPct = 2 + (PHASE_WEIGHTS.search + PHASE_WEIGHTS.posts) * 100 * 0.5 + PHASE_WEIGHTS.posts * 100 * 0.5 * (aboutDone / aboutTotal);
                Util.setProgress(progressPct, `Looked up r/${sub} · ${aboutDone} / ${aboutTotal} subs from posts`);
              }
            });
          } catch (e) {
            console.warn(`[discover] post-search failed:`, e && e.message);
          }
        }

        /* 3. Catalog seeding. Auto-detect issue / demographic spheres from
         *    the campaign keywords and pull their curated sub-list into
         *    the candidate pool. This guarantees that a healthcare
         *    campaign always considers r/MedicareForAll / r/healthcare
         *    even when Reddit's /subreddits/search misses them, and
         *    that strict mode never drops a known-good catalog member. */
        const autoSpheres = (window.Seeds && Seeds.detectSpheres(profile)) || [];
        /* Combine auto-detected with the user's manually picked ones. */
        const detectedSpheres = Array.from(new Set([...autoSpheres, ...(state.activeSpheres || [])]));
        let sphereSeedAttempted = 0, sphereSeedFetched = 0;
        progressPct = 2 + (PHASE_WEIGHTS.search + PHASE_WEIGHTS.posts) * 100;
        Util.setProgress(progressPct, detectedSpheres.length
          ? `Loading sphere catalog · ${detectedSpheres.length} sphere${detectedSpheres.length === 1 ? "" : "s"} detected (${detectedSpheres.slice(0, 3).join(", ")})`
          : `No matching spheres detected · skipping catalog`);
        if (detectedSpheres.length && window.Seeds) {
          const seedNames = Seeds.expand(detectedSpheres)
            .filter((sub) => !subResults.has(String(sub).toLowerCase()))
            .slice(0, 24);
          sphereSeedAttempted = seedNames.length;
          let seedDone = 0;
          await Util.pmap(seedNames, 3, async (sub) => {
            try {
              const about = await Reddit.fetchSubredditAbout(sub);
              if (about && about.display_name) {
                const k = about.display_name.toLowerCase();
                if (!subResults.has(k)) {
                  subResults.set(k, { candidate: about, hits: 0 });
                  sphereSeedFetched++;
                }
              }
            } catch (_) { /* ignore — sub may be private or proxy fail */ }
            finally {
              seedDone++;
              progressPct = 2 + (PHASE_WEIGHTS.search + PHASE_WEIGHTS.posts) * 100 + PHASE_WEIGHTS.catalog * 100 * (seedDone / Math.max(1, sphereSeedAttempted));
              Util.setProgress(progressPct, `Loading catalog · ${seedDone} / ${sphereSeedAttempted} seed sub${sphereSeedAttempted === 1 ? "" : "s"} (${sphereSeedFetched} new)`);
            }
          });
        }

        /* 4. Score & split into "new" vs "already in dashboard". */
        const exclude = new Set([
          ...(profile.subreddits || []),
          ...Array.from(state.activeSubs),
        ].map((s) => String(s).toLowerCase()));

        Util.setProgress(null, `Scoring ${subResults.size} candidate sub${subResults.size === 1 ? "" : "s"}…`);
        const result = Analysis.discoverCandidates(
          Array.from(subResults.values()).map((v) => v.candidate),
          profile,
          {
            excludeNames: Array.from(exclude),
            minSubs: 25,
            limit: 20,
            queryHitsByName,
            postHitsByName,
            strict: state.discoverStrict !== false,
          }
        );

        const dur = Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0));
        const f = result.filtered || { offtopic: 0, weak: 0, mega: 0 };
        const droppedTotal = f.offtopic + f.weak + f.mega;
        console.log(`[discover] ${campaign.name}: ${queries.length} queries · ${detectedSpheres.length} spheres (${sphereSeedFetched}/${sphereSeedAttempted} seeds fetched) · ${subResults.size} unique subs (${postHitsTotal} hot posts mined) → ${result.candidates.length} new + ${result.alreadyLoaded.length} already-loaded · ${droppedTotal} dropped by ${result.strict ? "strict" : "loose"} filter (offtopic=${f.offtopic} weak=${f.weak} mega=${f.mega}) · spheres=${detectedSpheres.join(",") || "—"} (${dur}ms)`);

const bestCampaignPost = (summary.posts || [])
          .slice()
          .sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;
        const campaignSubs = new Set((profile.subreddits || []).map((s) => String(s).toLowerCase()));
        UI.renderDiscoveryCandidates(result, discoverResults, {
          campaign,
          bestCampaignPost,
          campaignSubs,
        });
        updateSphereChipScores(result);
        Util.hideProgress(`${result.candidates.length} new sub${result.candidates.length === 1 ? "" : "s"} · ${result.alreadyLoaded.length} already loaded`);

        const sphereTail = detectedSpheres.length
          ? ` · detected sphere${detectedSpheres.length === 1 ? "" : "s"}: <em>${detectedSpheres.slice(0, 4).map(Util.escapeHtml).join(", ")}</em>${detectedSpheres.length > 4 ? ` +${detectedSpheres.length - 4} more` : ""}`
          : "";
        const filterTail = result.strict && droppedTotal
          ? ` · filtered ${droppedTotal} off-topic / generic sub${droppedTotal === 1 ? "" : "s"} (toggle All to see them)`
          : "";
        const status = result.candidates.length
          ? `Found <strong>${result.candidates.length}</strong> new sub${result.candidates.length === 1 ? "" : "s"} matching this campaign — plus ${result.alreadyLoaded.length} of your existing subs that also rank highly${sphereTail}${filterTail}.`
          : `Scanned ${result.totalScanned} sub${result.totalScanned === 1 ? "" : "s"} — every topical match is already in your dashboard${filterTail}${sphereTail}. Try toggling All, removing a filter chip, or running Discover on a campaign with broader themes.`;
        if (discoverStatus) {
          discoverStatus.style.display = "block";
          discoverStatus.className = "meta " + (result.candidates.length ? "ok" : "warn");
          discoverStatus.innerHTML = status;
        }
      } catch (err) {
        console.warn("[discover] failed:", err && err.message);
        setDiscoverStatus(`Discovery failed: ${(err && err.message) || err}`, "err");
        Util.hideProgress();
        discoverResults.innerHTML = "";
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
           * Reddit /submit page. We only auto-expand the tracker so
           * the URL-paste input is waiting when the user returns. */
          const card = openBtn.closest(".target-row");
          const tracker = card && card.querySelector(".cand-tracker");
          if (tracker) tracker.open = true;
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
        refreshData();
      },
      (sub) => {
        state.knownSubs = state.knownSubs.filter((s) => s !== sub);
        state.activeSubs.delete(sub);
        persist();
        renderChips();
        refreshData();
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
  function safeRun(label, fn) {
    try { fn(); }
    catch (err) {
      console.warn(`[init] ${label} failed:`, err && err.message);
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

  function init() {
    safeRun("loadPersisted", loadPersisted);
    safeRun("bind", bind);
    safeRun("wireTopbarHeightVar", wireTopbarHeightVar);
    /* Wire sync FIRST so the buttons + URL-hash banner are always live,
     * even if a later render step throws on a slow / weird browser. */
    safeRun("wireSyncSession", wireSyncSession);
    safeRun("renderChips", renderChips);
    safeRun("rerenderAll", rerenderAll);
    safeRun("refreshData", () => refreshData());
    safeRun("refreshAllCampaignSummaries", () => refreshAllCampaignSummaries());
    safeRun("checkStorageAvailability", checkStorageAvailability);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
