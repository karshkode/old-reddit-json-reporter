/* =====================================================================
 * POSTS VIEW
 * ---------------------------------------------------------------------
 * The raw explorer: every loaded post in one sortable, filterable,
 * paginated table, with a detail pane for comments and title analysis.
 *
 * Filtering is deliberately split in two. The free-text box and the
 * global topbar search share `state.searchQuery` and mirror each other,
 * because typing in one and getting a different result set in the other
 * is the kind of thing that makes a tool feel broken. The sub, min-score
 * and page-size controls are constraints layered on top of that.
 * ===================================================================== */
(function () {
  const View = {};

  /* Which posts survive the current filters is app.js's call — it owns
   * the shared filter state that the dashboard reads too. */
  function posts() {
    return App.filteredPosts();
  }

  View.render = function () {
    const list = App.renderPostsView();
    const count = Dom.byId("posts-count");
    if (count) count.textContent = Util.fmtNum(list.length);
  };

  View.subtitle = function () {
    const total = AppState.posts.length;
    if (!total) return "Nothing loaded yet";
    const shown = posts().length;
    return shown === total
      ? `${Util.fmtNum(total)} posts`
      : `${Util.fmtNum(shown)} of ${Util.fmtNum(total)} posts match`;
  };

  /* ------------------------------------------------------------------
   * Controls
   * ------------------------------------------------------------------ */

  function repaint() {
    AppState.postsPage = 0;
    App.rerenderLight();
    View.render();
  }

  function wireSearch() {
    const input = Dom.byId("posts-title-search");
    if (!input) return;
    const global = Dom.byId("search-input");
    if (global) input.value = global.value || "";

    const debounced = Util.debounce(() => {
      App.rerenderLight();
      View.render();
    }, 200);

    input.addEventListener("input", (e) => {
      AppState.searchQuery = e.target.value.trim();
      AppState.postsPage = 0;
      if (global && global.value !== e.target.value) global.value = e.target.value;
      debounced();
    });
  }

  function wireFilters() {
    const sub = Dom.byId("posts-sub-filter");
    if (sub) {
      sub.addEventListener("change", (e) => {
        AppState.postsSubFilter = e.target.value || "";
        repaint();
      });
    }

    const pageSize = Dom.byId("posts-page-size");
    if (pageSize) {
      pageSize.addEventListener("change", (e) => {
        AppState.postsPageSize = e.target.value === "all" ? "all" : Number(e.target.value) || 25;
        repaint();
      });
    }

    /* Min-score behaves as a radio group: one threshold at a time. */
    Dom.delegate(document, "click", ".pc-filter .chip-group [data-score-min]", (e, chip) => {
      const value = Number(chip.dataset.scoreMin || 0) || 0;
      if (AppState.postsScoreMin === value) return;
      AppState.postsScoreMin = value;
      for (const c of Dom.$$(".pc-filter .chip-group [data-score-min]")) {
        const on = Number(c.dataset.scoreMin || 0) === value;
        c.classList.toggle("active", on);
        c.setAttribute("aria-checked", on ? "true" : "false");
      }
      repaint();
    });
  }

  /* Column headers on desktop, a select on mobile — kept in step so
   * switching orientation does not show a stale sort. */
  function wireSort() {
    const mobile = Dom.byId("mobile-sort");

    function syncMobile() {
      if (!mobile) return;
      const value = `${AppState.sortKey}:${AppState.sortDir}`;
      if (Array.prototype.some.call(mobile.options, (o) => o.value === value)) mobile.value = value;
    }

    for (const th of Dom.$$("#posts-table thead th.sortable")) {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (AppState.sortKey === key) {
          AppState.sortDir = AppState.sortDir === "asc" ? "desc" : "asc";
        } else {
          AppState.sortKey = key;
          /* Text sorts read naturally A→Z; numbers and dates want the
           * biggest or newest first. */
          AppState.sortDir = ["title", "author", "id", "subreddit"].indexOf(key) >= 0 ? "asc" : "desc";
        }
        AppState.postsPage = 0;
        App.rerenderAll();
        syncMobile();
      });
    }

    if (mobile) {
      mobile.addEventListener("change", (e) => {
        const [key, dir] = e.target.value.split(":");
        AppState.sortKey = key;
        AppState.sortDir = dir === "asc" ? "asc" : "desc";
        App.rerenderAll();
      });
    }
    syncMobile();
  }

  View.mount = function () {
    wireSearch();
    wireFilters();
    wireSort();

    const close = Dom.byId("close-detail");
    if (close) close.addEventListener("click", UI.hidePostDetail);

    /* Re-read the open post on its own. The panel is where someone
       decides whether a post is still moving, and that question
       deserves a cheaper answer than re-reading every subreddit. */
    const sync = Dom.byId("post-detail-sync");
    if (sync) sync.addEventListener("click", () => {
      const id = sync.dataset.post;
      if (!id || sync.disabled) return;
      sync.disabled = true;
      sync.textContent = "Syncing…";
      Refresh.post(id).then((res) => {
        if (res && res.data) {
          UI.renderPostDetail(res.data.post, res.data.comments);
          App.renderRelatedForDetail(res.data.post);
        }
      }).finally(() => {
        sync.disabled = false;
        sync.textContent = "↻ Sync";
      });
    });

    /* Straight from the post you are reading to where it should go
       next. The dashboard card can pick any post, but nobody goes
       looking for a picker while already looking at the post. */
    const place = Dom.byId("post-detail-place");
    if (place) place.addEventListener("click", () => {
      const id = place.dataset.post;
      const post = id && AppState.posts.find((p) => p.id === id);
      if (post && window.FocusView) FocusView.focusPost(post);
    });
  };

  Router.register("posts", {
    title: "Posts",
    subtitle: View.subtitle,
    mount: View.mount,
    render: View.render,
  });

  window.PostsView = View;
})();
