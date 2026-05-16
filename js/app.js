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

  function setControlsExpanded(expanded) {
    const controls = document.getElementById("controls");
    const toggle = document.getElementById("filters-toggle");
    if (!controls) return;
    controls.classList.toggle("expanded", expanded);
    if (toggle) {
      toggle.classList.toggle("expanded", expanded);
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
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

  /* Lightweight render: KPIs + posts table only. Used during in-progress
   * batch fetches so the user sees data accumulate without paying the
   * per-update cost of redrawing 8 Chart.js canvases and recomputing
   * every theme/profile. */
  function rerenderLight() {
    const posts = filteredPosts();
    const agg = Analysis.aggregate(posts);
    UI.renderKpis(agg);
    UI.renderPostsTable(posts, state.sortKey, state.sortDir, openPostDetail);
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
    UI.renderPostsTable(posts, state.sortKey, state.sortDir, openPostDetail);

    if (window.Chart) {
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
      Charts.scatter("chart-scatter", posts);
      Charts.subCompare("chart-sub-compare", agg);
      Charts.histogram("chart-hist", Analysis.scoreHistogram(posts, 12));
      Charts.hourHeat("chart-hour-heat", agg);
      Charts.dow("chart-dow", agg);
      Charts.velocity("chart-velocity", posts);
      Charts.sentiment("chart-sentiment", sentiment);
    }

    UI.renderKeywords(Analysis.extractKeywords(posts, 30));
const crossPosts = Analysis.detectCrossPosts(posts);
    state.crossPosts = crossPosts;
    UI.renderCrossPosts(crossPosts);
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
        const controls = document.getElementById("controls");
        const expanded = !controls.classList.contains("expanded");
        setControlsExpanded(expanded);
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
    /* Card-help "?" tooltip. CSS handles desktop hover; this handler
     * adds tap-to-toggle on mobile and dismisses any open help when the
     * user taps elsewhere. Hover-tooltips on touch devices also briefly
     * stick around because of :focus, which we want. */
    document.body.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest && e.target.closest(".card-help");
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        document.querySelectorAll(".card-help.help-open").forEach((b) => {
          if (b !== btn) b.classList.remove("help-open");
        });
        btn.classList.toggle("help-open");
        return;
      }
      /* Click outside any help button closes them all */
      document.querySelectorAll(".card-help.help-open").forEach((b) => b.classList.remove("help-open"));
    });
    /* Escape also closes help popovers */
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        document.querySelectorAll(".card-help.help-open").forEach((b) => b.classList.remove("help-open"));
      }
    });

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

    /* "+ Make campaign" buttons inside the cross-posts card.
     * Each button carries data-cp-index referring to state.crossPosts.
     * Clicking it: derives a default name from the group's title or URL,
     * collects the post IDs, calls Campaigns.add, switches to the
     * Campaigns tab, and opens the new campaign in the detail panel. */
    const crosspostsEl = document.getElementById("crossposts");
    if (crosspostsEl) {
      crosspostsEl.addEventListener("click", (e) => {
        const btn = e.target && e.target.closest && e.target.closest('[data-action="make-campaign-from-crosspost"]');
        if (!btn) return;
        e.preventDefault();
        const idx = parseInt(btn.dataset.cpIndex || "-1", 10);
        const group = state.crossPosts && state.crossPosts[idx];
        if (!group) {
          Util.toast("Cross-post data not available — try refreshing.", "error");
          return;
        }
        const titleSrc = group.kind === "url" ? group.key : (group.posts[0] && group.posts[0].title) || "Cross-post";
        const trimmed = String(titleSrc).slice(0, 60).trim();
        const name = `Cross-post: ${trimmed}${trimmed.length === 60 ? "…" : ""}`;
        const postIds = group.posts.map((p) => p.id).filter(Boolean);

        try {
          const c = Campaigns.add({ name, postIds });
          if (Campaigns.persistErrorMessage()) {
            Util.toast(`Saved in this tab only — browser storage is unavailable (${Campaigns.persistErrorMessage()}).`, "error");
          } else {
            Util.toast(`Created campaign with ${postIds.length} post${postIds.length === 1 ? "" : "s"} from ${group.subs.length} subs`, "ok");
          }
          /* Visual confirmation on the button so the user sees it stuck. */
          btn.disabled = true;
          btn.dataset.originalText = btn.textContent;
          btn.textContent = "Created ✓";
          UI.activateTab("campaigns");
          UI.renderCampaignList(Campaigns.list(), state.campaignSummaries, openCampaign);
          populateTargetingSelectors();
          refreshAllCampaignSummaries().catch((err) => console.warn("[crosspost->campaign] summary refresh failed:", err && err.message));
          openCampaign(c);
          console.log(`[crosspost->campaign] "${name}" with ${postIds.length} ids in ${group.subs.length} subs`);
        } catch (err) {
          console.error("[crosspost->campaign] failed:", err);
          Util.toast(`Couldn't create campaign: ${(err && err.message) || err}`, "error");
        }
      });
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
    const closeOnSelect = (el) => {
      if (!el) return;
      el.addEventListener("change", () => {
        if (isMobile()) setControlsExpanded(false);
      });
    };
    closeOnSelect(document.getElementById("listing-select"));
    closeOnSelect(document.getElementById("time-select"));
    closeOnSelect(document.getElementById("limit-select"));

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
        const detectedSpheres = (window.Seeds && Seeds.detectSpheres(profile)) || [];
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

    /* "+ Add to dashboard" buttons inside discover-results: event delegation
     * so we don't need to re-bind on every render. */
    if (discoverResults) {
      discoverResults.addEventListener("click", (e) => {
        const btn = e.target && e.target.closest && e.target.closest('[data-action="add"]');
        if (!btn) return;
        const name = btn.dataset.name;
        if (!name) return;
        const norm = Util.normalizeSubName(name);
        if (!state.knownSubs.includes(norm)) state.knownSubs.push(norm);
        state.activeSubs.add(norm);
        persist();
        renderChips();
        Util.toast(`Added r/${norm} — fetching…`, "ok");
        const row = btn.closest(".target-row");
        if (row) row.classList.add("already");
        btn.disabled = true;
        btn.textContent = "Added ✓";
        refreshData();
      });
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

  function init() {
    loadPersisted();
    bind();
    renderChips();
    rerenderAll();
    refreshData();
    refreshAllCampaignSummaries();
    checkStorageAvailability();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
