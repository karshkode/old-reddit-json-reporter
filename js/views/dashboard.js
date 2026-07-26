/* =====================================================================
 * DASHBOARD VIEW
 * ---------------------------------------------------------------------
 * The audience-wide picture across every loaded subreddit. Merges what
 * used to be two separate tabs (Overview and Trends) into one scrollable
 * view with a section rail, because the split was arbitrary — "when do
 * posts go up" lived on one tab and "what hour do they do best" on the
 * other.
 *
 * Everything here derives from one Analysis.dashboard() call, so the
 * same code path serves the global scope and, in the campaign
 * workspace, a single campaign's posts.
 * ===================================================================== */
(function () {
  const View = {};

  let lastSignature = "";

  function esc(s) {
    return Util.escapeHtml(s == null ? "" : s);
  }

  /* Empty state, shown until the user has loaded anything. Gives the two
   * genuine next actions rather than an apologetic blank card. */
  function renderEmpty() {
    return Dom.emptyState({
      icon: "◧",
      title: "No data loaded yet",
      body: AppState.knownSubs.length
        ? `You have <strong>${AppState.activeSubs.size}</strong> subreddit${AppState.activeSubs.size === 1 ? "" : "s"} selected. Tap <strong>Go</strong> in the bar above to pull their latest posts.`
        : "Add some subreddits first — search for them, or load a whole curated sphere in one tap.",
      action: AppState.knownSubs.length
        ? ""
        : '<button class="btn primary" type="button" data-view="communities">Browse communities</button>',
    });
  }

  View.render = function () {
    const posts = App.filteredPosts();
    const emptyHost = Dom.byId("dashboard-empty");
    const contentHost = Dom.byId("dashboard-content");

    if (!posts.length) {
      if (emptyHost) {
        emptyHost.hidden = false;
        emptyHost.innerHTML = `<div class="card">${renderEmpty()}</div>`;
      }
      if (contentHost) contentHost.hidden = true;
      return;
    }
    if (emptyHost) { emptyHost.hidden = true; emptyHost.innerHTML = ""; }
    if (contentHost) contentHost.hidden = false;

    const bundle = Analysis.dashboard(posts, {
      window: AppState.timelineWindow,
      subProfiles: true,
      label: "All loaded subreddits",
    });

    UI.renderKpis(bundle.agg);
    UI.renderNarrative(Analysis.narrative(bundle.agg, bundle.sentiment, Array.from(AppState.activeSubs)));
    UI.renderRecommendations(Analysis.recommendations(bundle.agg, bundle.sentiment, posts));
    UI.renderKeywords(bundle.keywords);
    UI.renderThemes(bundle.themes);
    UI.renderSubProfiles(AppState.subProfiles);

    renderCharts(posts, bundle);
    App.renderCrossPostsView();
    updateScopeSummary(bundle);

    lastSignature = posts.length + ":" + AppState.timelineWindow + ":" + AppState.timelineMode;
  };

  function renderCharts(posts, bundle) {
    if (!window.Chart) return;

    function safe(label, fn) {
      try { fn(); } catch (err) { console.warn(`[dashboard] ${label}:`, err && err.message); }
    }

    safe("timeline", () => {
      const data = Analysis.bucketByTimePerSub(posts, { window: AppState.timelineWindow });
      Charts.timeline("chart-timeline", data, { mode: AppState.timelineMode });
      const hint = Dom.byId("timeline-hint");
      if (!hint) return;
      const modeLabel = {
        total: "All subs combined",
        stacked: "Stacked by sub",
        density: "Each sub at its own peak",
      }[AppState.timelineMode] || "One line per sub";
      const winLabel = AppState.timelineWindow === "all"
        ? "all loaded data"
        : AppState.timelineWindow === "auto"
          ? `auto window (${data.windowLabel})`
          : `last ${AppState.timelineWindow}`;
      const dropped = data.droppedCount
        ? ` · ${data.droppedCount} older post${data.droppedCount === 1 ? "" : "s"} hidden`
        : "";
      hint.textContent = `${modeLabel} · ${winLabel} · ${data.bucketLabel} buckets · ${data.subs.length} sub${data.subs.length === 1 ? "" : "s"}${dropped}`;
    });

    safe("scatter", () => Charts.scatter("chart-scatter", posts));
    safe("subCompare", () => Charts.subCompare("chart-sub-compare", bundle.agg));
    safe("histogram", () => Charts.histogram("chart-hist", bundle.histogram));
    safe("hourHeat", () => Charts.hourHeat("chart-hour-heat", bundle.agg));
    safe("dow", () => Charts.dow("chart-dow", bundle.agg));
    safe("velocity", () => Charts.velocity("chart-velocity", posts));
    safe("sentiment", () => Charts.sentiment("chart-sentiment", bundle.sentiment));
  }

  /* The scope bar carries a one-line "what am I looking at" summary so
   * the numbers on screen always have their provenance attached. */
  function updateScopeSummary(bundle) {
    const el = Dom.byId("scope-summary");
    if (!el) return;
    const n = bundle.count;
    if (!n) { el.textContent = ""; return; }
    const subs = bundle.agg.bySubreddit ? Object.keys(bundle.agg.bySubreddit).length : 0;
    el.textContent = `${Util.fmtNum(n)} posts · ${subs} sub${subs === 1 ? "" : "s"} · ${AppState.listing} · ${AppState.timeWindow}`;
  }

  View.subtitle = function () {
    const n = AppState.posts.length;
    if (!n) return "Nothing loaded yet";
    return `${Util.fmtNum(n)} posts across ${AppState.activeSubs.size} subreddit${AppState.activeSubs.size === 1 ? "" : "s"}`;
  };

  /* ------------------------------------------------------------------
   * Wiring
   * ------------------------------------------------------------------ */

  View.mount = function () {
    /* Timeline mode + window segmented controls. */
    Dom.delegate(document, "click", "#timeline-card .chart-mode:not(.chart-window) button", (e, btn) => {
      AppState.timelineMode = btn.dataset.mode;
      for (const sib of btn.parentElement.children) sib.classList.toggle("active", sib === btn);
      View.render();
    });
    Dom.delegate(document, "click", "#timeline-card .chart-window button", (e, btn) => {
      AppState.timelineWindow = btn.dataset.window;
      for (const sib of btn.parentElement.children) sib.classList.toggle("active", sib === btn);
      View.render();
    });

    /* Section rail: smooth-scroll and reflect the section in view. */
    Dom.delegate(document, "click", "#view-dashboard .section-rail a", (e, link) => {
      e.preventDefault();
      const target = Dom.byId(link.dataset.jump);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      for (const sib of link.parentElement.children) sib.classList.toggle("active", sib === link);
    });
  };

  Router.register("dashboard", {
    title: "Dashboard",
    subtitle: View.subtitle,
    mount: View.mount,
    render: View.render,
  });

  window.DashboardView = View;
})();
