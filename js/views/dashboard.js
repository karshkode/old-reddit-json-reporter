/* =====================================================================
 * DASHBOARD VIEW
 * ---------------------------------------------------------------------
 * The audience-wide picture across every loaded subreddit. Fourteen
 * cards and ten charts is far too much for one column — on a phone the
 * whole thing measured close to eleven screenfuls of scrolling — so the
 * rail across the top is a real tab strip rather than a set of jump
 * links. Only the selected section is in the document flow.
 *
 * That also makes the render cheaper than the scrolling version ever
 * was: a repaint builds the charts for one section instead of all of
 * them, and Chart.js is never asked to size a canvas inside a hidden
 * container.
 *
 * Everything here derives from one Analysis.dashboard() call, cached
 * against the current scope so flipping between tabs re-uses the
 * existing analysis instead of recomputing it.
 * ===================================================================== */
(function () {
  const View = {};

  const SECTIONS = ["summary", "timing", "charts", "themes", "communities", "crossposts"];
  const RAIL = "dashboard-section-rail";

  /* The last analysis and the scope it was computed for. */
  let bundle = null;
  let timingModel = null;
  let signature = "";

  /* Sections already painted from the current `bundle`. Repainting an
   * unchanged section would throw away in-place state the user built up,
   * like an expanded theme list, so we only draw a section once per
   * analysis. */
  const painted = new Set();

  /* How many per-subreddit timing panels to draw before collapsing the
   * rest behind a button. Twenty charts on one card is a stall. */
  let timingLimit = 6;

  /* The summary's When row keeps its own truncation, independent of the
   * Timing tab's — expanding one should not silently expand the other. */
  let briefingTimingLimit = null;

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

  function activeSection() {
    const s = AppState.dashSection;
    return SECTIONS.indexOf(s) === -1 ? "summary" : s;
  }

  /* Identifies the data the current analysis was built from, so a
   * repaint can re-use it and a genuine change cannot go unnoticed. The
   * ends of the list plus its length pin the contents down without
   * walking every post; the timeline controls are in here too because
   * they decide the bucketing the bundle carries. */
  function scopeSignature(posts) {
    const first = posts[0];
    const last = posts[posts.length - 1];
    return [
      posts.length,
      first ? first.id : "",
      last ? last.id : "",
      AppState.activeSubs.size,
      AppState.timelineWindow,
      AppState.timelineMode,
    ].join(":");
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
      /* The rail lives inside the content wrapper, so an empty
       * dashboard shows the empty state alone rather than six tabs
       * over six empty panels. */
      return;
    }
    if (emptyHost) { emptyHost.hidden = true; emptyHost.innerHTML = ""; }
    if (contentHost) contentHost.hidden = false;

    const sig = scopeSignature(posts);
    if (sig !== signature) {
      bundle = Analysis.dashboard(posts, {
        window: AppState.timelineWindow,
        label: "All loaded subreddits",
      });
      timingModel = Analysis.postingTimes(posts);
      signature = sig;
      painted.clear();
    }

    UI.renderKpis(bundle.agg, timingModel);
    updateScopeSummary(bundle);
    paintSection();
  };

  /* Draw whichever section the rail is on, once per analysis. */
  function paintSection() {
    const section = activeSection();
    Dom.paintRail(RAIL, "dash-tab", section, "dash-", ".dash-section");
    if (!bundle || painted.has(section)) return;
    painted.add(section);

    const posts = bundle.posts;
    if (section === "summary") {
      UI.renderBriefing(
        Analysis.postingBriefing(posts, { agg: bundle.agg, timing: timingModel }),
        { timingLimit: briefingTimingLimit }
      );
    } else if (section === "timing") {
      UI.renderPostingTimes(timingModel, { limit: timingLimit });
      renderTimeline(posts);
    } else if (section === "charts") {
      renderCharts(posts, bundle);
    } else if (section === "themes") {
      UI.renderKeywords(bundle.keywords);
      UI.renderThemes(bundle.themes);
    } else if (section === "communities") {
      UI.renderSubProfiles(AppState.subProfiles);
    } else if (section === "crossposts") {
      App.renderCrossPostsView();
    }
  }

  View.goToSection = function (section) {
    if (SECTIONS.indexOf(section) === -1) return;
    AppState.dashSection = section;
    paintSection();
    Dom.revealRailTab(RAIL, "dash-tab", section);
    /* Land at the top of the new section rather than wherever the last
     * one had been scrolled to. */
    const view = Dom.byId("view-dashboard");
    if (view) window.scrollTo({ top: Math.max(0, view.offsetTop - 8), behavior: "auto" });
  };

  /* Open the Timing tab on one particular community's panel.
   *
   * The panel may be past the truncation point, so the limit is raised
   * to reach it — far enough and no further. Jumping straight to "all"
   * would be simpler, but someone with a hundred loaded subreddits
   * would pay for a hundred charts to look at one of them. */
  View.revealTiming = function (key) {
    if (!timingModel || !key) return;
    const ranked = timingModel.ranked || [];
    const idx = ranked.findIndex((r) => r.key === key);
    if (idx === -1) return;

    const drawn = timingLimit === "all" ? ranked.length : timingLimit;
    if (idx >= drawn) {
      timingLimit = idx + 1;
      painted.delete("timing");
    }

    AppState.dashSection = "timing";
    paintSection();
    Dom.revealRailTab(RAIL, "dash-tab", "timing");

    const panel = document.querySelector(`.timing-panel[data-sub="${CSS.escape(key)}"]`);
    if (!panel) return;
    panel.scrollIntoView({ block: "center", behavior: "smooth" });
    /* A brief outline so it is obvious which of a dozen near-identical
     * panels the tap landed on. */
    panel.classList.remove("is-target");
    void panel.offsetWidth;
    panel.classList.add("is-target");
    window.setTimeout(() => panel.classList.remove("is-target"), 2000);
  };

  function safe(label, fn) {
    try { fn(); } catch (err) { console.warn(`[dashboard] ${label}:`, err && err.message); }
  }

  function renderTimeline(posts) {
    if (!window.Chart) return;
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
  }

  function renderCharts(posts, bundle) {
    if (!window.Chart) return;
    safe("scatter", () => Charts.scatter("chart-scatter", posts));
    safe("subCompare", () => Charts.subCompare("chart-sub-compare", bundle.agg));
    safe("histogram", () => Charts.histogram("chart-hist", bundle.histogram));
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

    Dom.delegate(document, "click", '[data-action="show-all-timing"]', () => {
      timingLimit = "all";
      /* Same scope, so the cached analysis stands — only this section's
       * markup needs redrawing. */
      painted.delete("timing");
      paintSection();
    });

    Dom.delegate(document, "click", '[data-action="expand-briefing-timing"]', () => {
      briefingTimingLimit = "all";
      painted.delete("summary");
      paintSection();
    });

    /* Drill from a row of the summary's When list into that community's
     * own chart. Without this the list was a dead end: it named the
     * slot but gave no way through to the evidence behind it. */
    Dom.delegate(document, "click", "[data-timing-goto]", (e, el) => {
      View.revealTiming(el.dataset.timingGoto);
    });
    Dom.delegate(document, "keydown", "[data-timing-goto]", (e, el) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      View.revealTiming(el.dataset.timingGoto);
    });

    Dom.wireRail(RAIL, "dash-tab", View.goToSection);

    /* Buttons elsewhere in the app that deep-link to a section. */
    Dom.delegate(document, "click", "[data-dash-goto]", (e, btn) => {
      e.preventDefault();
      Router.go("dashboard");
      View.goToSection(btn.dataset.dashGoto);
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
