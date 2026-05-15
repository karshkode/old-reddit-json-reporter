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
  };

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

  function rerenderAll() {
    const posts = filteredPosts();
    const agg = Analysis.aggregate(posts);
    const sentiment = Analysis.aggregateSentiment(posts);

    UI.renderKpis(agg);
    UI.renderPostsTable(posts, state.sortKey, state.sortDir, openPostDetail);

    if (window.Chart) {
      Charts.timeline("chart-timeline", Analysis.bucketByHour(posts));
      Charts.scatter("chart-scatter", posts);
      Charts.subCompare("chart-sub-compare", agg);
      Charts.histogram("chart-hist", Analysis.scoreHistogram(posts, 12));
      Charts.hourHeat("chart-hour-heat", agg);
      Charts.dow("chart-dow", agg);
      Charts.velocity("chart-velocity", posts);
      Charts.sentiment("chart-sentiment", sentiment);
    }

    UI.renderKeywords(Analysis.extractKeywords(posts, 30));
    UI.renderCrossPosts(Analysis.detectCrossPosts(posts));
    UI.renderRecommendations(Analysis.recommendations(agg, sentiment, posts));
    UI.renderNarrative(Analysis.narrative(agg, sentiment, Array.from(state.activeSubs)));
  }

  /* ---------- Data fetch ---------- */

  async function refreshData(force) {
    if (!state.activeSubs.size) {
      state.posts = [];
      Util.setStatus("No active subreddits selected.", "err");
      hideBanner();
      rerenderAll();
      return;
    }
    if (force) Reddit.clearCache();
    const subs = Array.from(state.activeSubs);
    Util.setStatus(`Fetching ${subs.length} subreddit${subs.length > 1 ? "s" : ""}…`, "", "via " + describeTransport());
    state.lastErrors = [];
    const all = [];
    let errors = 0;
    for (const sub of subs) {
      try {
        const list = await Reddit.fetchSubredditListing(sub, {
          listing: state.listing,
          t: state.timeWindow,
          limit: state.limit,
        });
        for (const p of list) all.push(p);
      } catch (err) {
        errors++;
        state.lastErrors.push({ sub, message: err.message });
        Util.toast(`r/${sub}: ${err.message}`, "error");
      }
    }
    state.posts = Util.uniqBy(all, (p) => p.id);
    state.lastTransport = Reddit._lastTransport || state.lastTransport;
    Util.setStatus(
      `Loaded ${state.posts.length} posts from ${subs.length} subreddit${subs.length > 1 ? "s" : ""}` +
      (errors ? ` · ${errors} error${errors > 1 ? "s" : ""}` : ""),
      errors ? "err" : "ok",
      "via " + describeTransport()
    );
    if (state.posts.length === 0 && state.activeSubs.size > 0) {
      const errLines = state.lastErrors.map((e) => `<li><code>r/${Util.escapeHtml(e.sub)}</code> — ${Util.escapeHtml(e.message)}</li>`).join("");
      showBanner("bad", `
        <strong>All Reddit fetches failed.</strong>
        Reddit doesn't send CORS headers for browser requests, so this site routes through public CORS proxies. The currently selected proxy may be down or rate-limited.
        <ul style="margin:6px 0 0 18px;padding:0">${errLines}</ul>
        <span class="hint">Try picking a different <strong>Data source</strong> in the top bar, or wait a minute and click <strong>Refresh</strong>.</span>
      `);
    } else if (state.posts.length > 0) {
      hideBanner();
    }
    rerenderAll();
    refreshAllCampaignSummaries();
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
    const summaries = {};
    for (const c of list) {
      try {
        const agg = await Campaigns.fetchAggregated(c);
        summaries[c.id] = agg;
      } catch (err) {
        summaries[c.id] = { totalScore: 0, totalComments: 0, posts: [], subs: [], missing: c.postIds };
      }
    }
    state.campaignSummaries = summaries;
    UI.renderCampaignList(Campaigns.list(), summaries, openCampaign);
  }

  async function openCampaign(campaign) {
    const card = document.getElementById("campaign-detail");
    const body = document.getElementById("campaign-detail-body");
    card.hidden = false;
    body.innerHTML = `<div class="empty"><div class="skeleton" style="margin-bottom:6px"></div><div class="skeleton" style="margin-bottom:6px;width:80%"></div><div class="skeleton" style="width:60%"></div></div>`;
    state.openCampaignId = campaign.id;
    try {
      const agg = await Campaigns.fetchAggregated(campaign);
      state.campaignSummaries[campaign.id] = agg;
      UI.renderCampaignDetail(campaign, agg);
      UI.renderCampaignList(Campaigns.list(), state.campaignSummaries, openCampaign);
    } catch (err) {
      body.innerHTML = `<div class="empty">Failed to fetch campaign data: ${Util.escapeHtml(err.message)}</div>`;
    }
  }

  /* ---------- Wire UI ---------- */

  function bind() {
    const transportSelect = document.getElementById("transport-select");
    if (transportSelect) {
      for (const t of Reddit.TRANSPORTS) {
        const opt = document.createElement("option");
        opt.value = t.name;
        opt.textContent = t.label;
        transportSelect.appendChild(opt);
      }
      transportSelect.value = Reddit.getTransport();
      transportSelect.addEventListener("change", (e) => {
        Reddit.setTransport(e.target.value);
        Reddit.clearCache();
        Util.toast(`Data source: ${e.target.value}`, "ok");
        refreshData(true);
      });
      Reddit.onTransportSuccess = function (name) {
        state.lastTransport = name;
      };
    }

    document.getElementById("refresh-btn").addEventListener("click", () => refreshData(true));
    document.getElementById("clear-cache-btn").addEventListener("click", () => {
      Reddit.clearCache();
      Util.toast("Cache cleared", "ok");
    });

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
    document.getElementById("post-id-filter").addEventListener("input", (e) => {
      state.postIdFilter = Util.parseIdList(e.target.value);
      debouncedFilter();
    });
    document.getElementById("search-input").addEventListener("input", (e) => {
      state.searchQuery = e.target.value.trim();
      debouncedFilter();
    });

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => UI.activateTab(tab.dataset.tab));
    });

    document.querySelectorAll("#posts-table thead th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const k = th.dataset.sort;
        if (state.sortKey === k) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        else { state.sortKey = k; state.sortDir = (k === "title" || k === "author" || k === "id" || k === "subreddit") ? "asc" : "desc"; }
        rerenderAll();
      });
    });

    document.getElementById("close-detail").addEventListener("click", UI.hidePostDetail);

    document.getElementById("campaign-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("campaign-name").value.trim();
      const goalScore = document.getElementById("campaign-goal-score").value;
      const goalComments = document.getElementById("campaign-goal-comments").value;
      const ids = Util.parseIdList(document.getElementById("campaign-post-ids").value);
      if (!name) return Util.toast("Campaign needs a name", "error");
      const c = Campaigns.add({ name, goalScore, goalComments, postIds: ids });
      Util.toast(`Saved "${c.name}"`, "ok");
      document.getElementById("campaign-form").reset();
      await refreshAllCampaignSummaries();
      openCampaign(c);
    });

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

  function init() {
    loadPersisted();
    bind();
    renderChips();
    rerenderAll();
    refreshData();
    refreshAllCampaignSummaries();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
