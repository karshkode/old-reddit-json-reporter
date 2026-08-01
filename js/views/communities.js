/* =====================================================================
 * COMMUNITIES VIEW
 * ---------------------------------------------------------------------
 * Three jobs that used to be scattered or missing entirely:
 *
 *   Search    a real subreddit search — typeahead over cached names plus
 *             live autocomplete and full search — where every result can
 *             expand to show the communities most similar to it.
 *   Catalog   the curated progressive-sphere catalog, browsable, with
 *             one-tap bulk loading. Previously the catalog only nudged
 *             discovery scores; nothing surfaced it to the user and the
 *             starter drawer appeared exactly once, on an empty install.
 *   Loaded    what is currently in the dashboard, and whether each sub
 *             is included in the next fetch.
 * ===================================================================== */
(function () {
  const esc = (s) => Util.escapeHtml(s == null ? "" : s);
  const num = (n) => Util.fmtNum(n || 0);

  const View = {};

  let searchToken = 0;
  let debounceTimer = null;

  /* ==================================================================
   * SHARED: a subreddit result row
   * ================================================================== */

  function sphereBadges(name) {
    const keys = Seeds.spheresOf(name).slice(0, 3);
    if (!keys.length) return "";
    return keys.map((k) => {
      const clean = k.replace(/^(state|demo):/, "");
      return `<span class="badge">${esc(Seeds.labelOf(clean))}</span>`;
    }).join("");
  }

  function subRow(record, opts) {
    opts = opts || {};
    const loaded = AppState.hasSub(record.display_name);
    const desc = (record.public_description || record.title || "").trim();
    return `
      <div class="sub-result" data-sub="${esc(record.display_name)}">
        <div class="sub-result-main">
          <div class="sub-result-head">
            <a class="sub-result-name" href="https://www.reddit.com/r/${encodeURIComponent(record.display_name)}/" target="_blank" rel="noopener">r/${esc(record.display_name)}</a>
            ${record.subscribers ? `<span class="meta">${num(record.subscribers)} members</span>` : ""}
            ${record.active_user_count ? `<span class="badge good">${num(record.active_user_count)} online</span>` : ""}
            ${sphereBadges(record.display_name)}
            ${opts.scoreBadge ? `<span class="badge accent">${opts.scoreBadge}</span>` : ""}
          </div>
          ${desc ? `<div class="sub-result-desc">${esc(desc.slice(0, 190))}${desc.length > 190 ? "…" : ""}</div>` : ""}
          ${opts.note ? `<div class="sub-result-note">${opts.note}</div>` : ""}
        </div>
        <div class="sub-result-actions">
          <button class="btn small ${loaded ? "" : "primary"}" type="button"
                  data-action="${loaded ? "remove-sub" : "add-sub-row"}"
                  data-sub="${esc(record.display_name)}">${loaded ? "✓ Added" : "＋ Add"}</button>
          <button class="btn small ghost" type="button" data-action="similar" data-sub="${esc(record.display_name)}">Similar</button>
        </div>
        <div class="sub-similar" data-similar-for="${esc(record.display_name.toLowerCase())}" hidden></div>
      </div>`;
  }

  /* ==================================================================
   * SEARCH
   * ================================================================== */

  function setSearchStatus(text, kind) {
    const el = Dom.byId("sub-search-status");
    if (!el) return;
    el.hidden = !text;
    el.className = "meta " + (kind || "");
    el.innerHTML = text || "";
  }

  async function runSearch(query, opts) {
    opts = opts || {};
    const host = Dom.byId("sub-search-results");
    if (!host) return;
    const q = String(query || "").trim();
    AppState.communitiesQuery = q;

    if (!q) {
      host.innerHTML = renderSearchIdle();
      setSearchStatus("");
      return;
    }

    const token = ++searchToken;

    /* Two passes. The first is offline — the local index plus the
     * curated catalog — and paints immediately, so typing feels
     * instant and the box still returns something useful when the
     * archive is unreachable. The second adds what the archive knows. */
    if (opts.instant !== false) {
      const offline = await Discovery.searchSubreddits(q, { limit: 12, live: false });
      if (token !== searchToken) return;
      if (offline.length) {
        AppState.communitiesResults = offline;
        host.innerHTML = offline.map((r) => subRow(r.record)).join("");
        setSearchStatus(`${offline.length} from your local index and the catalog · asking the archive for more…`);
      } else {
        host.innerHTML = Dom.skeleton(4);
        setSearchStatus("Searching the archive…");
      }
    }

    let results;
    try {
      results = await Discovery.searchSubreddits(q, { limit: 30 });
    } catch (err) {
      if (token !== searchToken) return;
      setSearchStatus(`The archive didn't answer: ${esc((err && err.message) || err)}. Results above are from your local index and the catalog.`, "err");
      return;
    }
    if (token !== searchToken) return;

    if (!results.length) {
      host.innerHTML = Dom.emptyState({
        icon: "⌗",
        title: `Nothing found for "${esc(q)}"`,
        body: "Try a broader term, or browse the curated sphere catalog.",
        action: '<button class="btn" type="button" data-communities-tab="catalog">Open the catalog</button>',
      });
      setSearchStatus("");
      return;
    }

    AppState.communitiesResults = results;
    host.innerHTML = `
      <div class="sub-result-toolbar">
        <span class="meta">${results.length} communit${results.length === 1 ? "y" : "ies"}</span>
        <button class="btn small" type="button" data-action="add-all-results">＋ Add top 10</button>
      </div>
      ${results.map((r) => subRow(r.record, {
        note: r.exact ? "Exact name match" : "",
      })).join("")}`;
    setSearchStatus("");
  }

  function renderSearchIdle() {
    /* Drawn from the catalog rather than hardcoded, so a suggestion can
     * never be a chip that returns nothing when the proxies are down. */
    const suggestions = Object.keys(Seeds.ISSUE_SPHERES || {})
      .sort((a, b) => (Seeds.ISSUE_SPHERES[b].length || 0) - (Seeds.ISSUE_SPHERES[a].length || 0))
      .slice(0, 6)
      .map((k) => Seeds.labelOf(k));
    return Dom.emptyState({
      icon: "⌕",
      title: "Search for communities",
      body: "Type an issue, a slogan or a subreddit name. Every result can expand to show the communities most like it, so one good sub leads to its whole neighbourhood.",
      action: `<div class="chips" style="justify-content:center">${suggestions
        .map((s) => `<button class="chip" type="button" data-search-suggest="${esc(s)}">${esc(s)}</button>`)
        .join("")}</div>`,
    });
  }

  /* ------------------------------------------------------------------
   * Similar communities, inline under a result
   * ------------------------------------------------------------------ */

  async function toggleSimilar(name) {
    const panel = document.querySelector(`[data-similar-for="${CSS.escape(name.toLowerCase())}"]`);
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; return; }

    panel.hidden = false;
    panel.innerHTML = Dom.skeleton(3);

    let result;
    try {
      result = await Discovery.findSimilar(name, { limit: 10 });
    } catch (err) {
      panel.innerHTML = `<div class="meta err">Could not derive similar communities: ${esc((err && err.message) || err)}</div>`;
      return;
    }

    if (!result.similar.length) {
      panel.innerHTML = `<div class="meta">No confident neighbours found. Reddit has no related-subreddits endpoint, so this depends on description overlap and recent cross-posting — both can come up empty for a very niche sub.</div>`;
      return;
    }

    panel.innerHTML = `
      <div class="sub-similar-head">
        <strong>Communities like r/${esc(name)}</strong>
        <span class="hint">Derived locally from description overlap, catalog co-membership, live search and recent cross-posting — each row shows which signals agreed.</span>
        <button class="btn tiny" type="button" data-action="add-all-similar" data-sub="${esc(name)}">＋ Add all ${result.similar.length}</button>
      </div>
      <div class="sub-similar-list">
        ${result.similar.map((s) => {
          const loaded = AppState.hasSub(s.name);
          return `
            <div class="sub-similar-row">
              <div class="ssr-main">
                <a href="https://www.reddit.com/r/${encodeURIComponent(s.name)}/" target="_blank" rel="noopener">r/${esc(s.name)}</a>
                <span class="badge accent">${s.score}</span>
                ${s.record.subscribers ? `<span class="meta">${num(s.record.subscribers)}</span>` : ""}
                <span class="ssr-sources">${s.sources.map((x) => `<span class="badge">${esc(x)}</span>`).join("")}</span>
                ${s.terms.length ? `<span class="ssr-terms">shares ${s.terms.slice(0, 3).map((t) => `<code>${esc(t)}</code>`).join(" ")}</span>` : ""}
              </div>
              <button class="btn tiny ${loaded ? "" : "primary"}" type="button"
                      data-action="${loaded ? "remove-sub" : "add-sub-row"}"
                      data-sub="${esc(s.name)}">${loaded ? "✓" : "＋"}</button>
            </div>`;
        }).join("")}
      </div>`;

    panel._similar = result.similar.map((s) => s.name);
  }

  /* ==================================================================
   * CATALOG
   * ================================================================== */

  function renderCatalog() {
    const kind = AppState.catalogFilter || "issue";
    const bundleHost = Dom.byId("catalog-bundles");
    const gridHost = Dom.byId("catalog-grid");

    if (bundleHost) {
      bundleHost.hidden = kind !== "issue";
      if (kind === "issue") {
        bundleHost.innerHTML = `
          <div class="catalog-bundle-head">
            <strong>Starter bundles</strong>
            <span class="hint">Combinations that make a sensible first load. Available any time, not just on a fresh install.</span>
          </div>
          <div class="catalog-bundle-row">
            ${Seeds.BUNDLES.map((b) => {
              const subs = Seeds.bundleSubs(b.key);
              const missing = subs.filter((s) => !AppState.hasSub(s)).length;
              return `
                <button class="catalog-bundle" type="button" data-action="load-bundle" data-bundle="${esc(b.key)}" title="${esc(b.description)}">
                  <span class="catalog-bundle-label">${esc(b.label)}</span>
                  <span class="catalog-bundle-meta">${subs.length} subs${missing ? ` · ${missing} new` : " · all loaded"}</span>
                </button>`;
            }).join("")}
          </div>`;
      }
    }

    if (!gridHost) return;
    const map = kind === "issue" ? Seeds.ISSUE_SPHERES
      : kind === "audience" ? Seeds.DEMOGRAPHIC_SPHERES
        : Seeds.STATE_SPHERES;

    const entries = Object.entries(map).sort((a, b) => Seeds.labelOf(a[0]).localeCompare(Seeds.labelOf(b[0])));

    gridHost.innerHTML = entries.map(([key, subs]) => {
      const loadedCount = subs.filter((s) => AppState.hasSub(s)).length;
      const allLoaded = loadedCount === subs.length;
      const known = subs.map((s) => SubIndex.get(s)).filter(Boolean);
      const reach = known.reduce((acc, r) => acc + (r.subscribers || 0), 0);
      return `
        <div class="catalog-card" data-sphere="${esc(key)}">
          <header class="catalog-card-head">
            <div>
              <h3>${esc(Seeds.labelOf(key))}</h3>
              <span class="hint">${subs.length} communities${reach ? ` · ${num(reach)} combined members` : ""}${loadedCount ? ` · ${loadedCount} loaded` : ""}</span>
            </div>
            <button class="btn small ${allLoaded ? "" : "primary"}" type="button"
                    data-action="load-sphere" data-sphere="${esc(key)}" ${allLoaded ? "disabled" : ""}>
              ${allLoaded ? "✓ All loaded" : `＋ Load all ${subs.length}`}
            </button>
          </header>
          <div class="catalog-card-subs">
            ${subs.map((s) => {
              const on = AppState.hasSub(s);
              return `<button class="chip ${on ? "active" : ""}" type="button" data-action="toggle-catalog-sub" data-sub="${esc(s)}">${on ? "✓ " : "＋ "}r/${esc(s)}</button>`;
            }).join("")}
          </div>
        </div>`;
    }).join("");
  }

  /* ==================================================================
   * LOADED SUBS
   * ================================================================== */

  function renderLoaded() {
    const host = Dom.byId("loaded-subs-grid");
    if (!host) return;
    const subs = AppState.knownSubs.slice().sort((a, b) => a.localeCompare(b));

    if (!subs.length) {
      host.innerHTML = Dom.emptyState({
        icon: "⌗",
        title: "No subreddits yet",
        body: "Search for communities or load a curated sphere to get started.",
        action: '<button class="btn primary" type="button" data-communities-tab="catalog">Browse the catalog</button>',
      });
      return;
    }

    host.innerHTML = subs.map((s) => {
      const on = AppState.activeSubs.has(s);
      const record = SubIndex.get(s);
      const posts = AppState.postsForSub(s).length;
      return `
        <div class="loaded-sub ${on ? "" : "off"}">
          <label class="loaded-sub-toggle">
            <input type="checkbox" data-action="toggle-active-sub" data-sub="${esc(s)}" ${on ? "checked" : ""} />
            <span class="loaded-sub-name">r/${esc(s)}</span>
          </label>
          <div class="loaded-sub-meta">
            ${record && record.subscribers ? `${num(record.subscribers)} members · ` : ""}${posts ? `${num(posts)} posts loaded` : "no posts loaded"}
          </div>
          <button class="btn tiny danger-soft" type="button" data-action="remove-sub" data-sub="${esc(s)}" aria-label="Remove r/${esc(s)}">Remove</button>
        </div>`;
    }).join("");
  }

  /* ==================================================================
   * BULK ADD
   * ================================================================== */

  function bulkAdd(names, label) {
    const added = AppState.addSubs(names);
    App.renderChips();
    App.markPending();
    View.render();
    Router.invalidate(["dashboard", "posts"]);
    if (added.length) {
      Util.toast(`Added ${added.length} subreddit${added.length === 1 ? "" : "s"}${label ? ` from ${label}` : ""} — tap Go to load their posts`);
    } else {
      Util.toast(`Every sub${label ? ` in ${label}` : ""} was already in your dashboard`);
    }
    /* Warm the index in the background so the catalog can show real
     * subscriber counts and so similarity search has descriptions to
     * compare against. */
    SubIndex.ensure(names, { limit: 30, concurrency: 3 }).then(() => {
      Discovery.invalidateSpheres();
      if (Router.current() === "communities") View.render();
    }).catch(() => {});
  }

  /* ==================================================================
   * VIEW LIFECYCLE
   * ================================================================== */

  function paintTabs() {
    const active = AppState.communitiesTab || "search";
    for (const btn of Dom.$$("#communities-rail [data-communities-tab]")) {
      btn.classList.toggle("active", btn.dataset.communitiesTab === active);
    }
    for (const sec of Dom.$$("#view-communities .communities-section")) {
      sec.classList.toggle("active", sec.id === "comm-sec-" + active);
    }
  }

  View.render = function () {
    paintTabs();
    const tab = AppState.communitiesTab || "search";
    if (tab === "catalog") renderCatalog();
    else if (tab === "loaded") renderLoaded();
    else if (!AppState.communitiesQuery) {
      const host = Dom.byId("sub-search-results");
      if (host && !host.innerHTML.trim()) host.innerHTML = renderSearchIdle();
    }
  };

  View.goToTab = function (tab) {
    AppState.communitiesTab = tab;
    View.render();
  };

  /* The scope bar's "+ Add" lands here rather than opening a second,
   * dumber add-a-subreddit box: one search surface, and it is the one
   * that can show you a community's neighbours before you commit. */
  View.openSearch = function () {
    Router.go("communities");
    View.goToTab("search");
    const input = Dom.byId("sub-search-input");
    if (input) {
      input.focus();
      input.select();
    }
  };

  View.mount = function () {
    const form = Dom.byId("sub-search-form");
    const input = Dom.byId("sub-search-input");

    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        runSearch(input ? input.value : "");
      });
    }
    if (input) {
      /* Debounced typeahead. 260ms is long enough that a fast typist
       * does not fire a request per keystroke, short enough that it
       * still feels like it is keeping up. */
      input.addEventListener("input", () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        const value = input.value;
        if (value.trim().length < 2) {
          searchToken++;
          const host = Dom.byId("sub-search-results");
          if (host) host.innerHTML = renderSearchIdle();
          setSearchStatus("");
          return;
        }
        debounceTimer = setTimeout(() => runSearch(value), 260);
      });
    }

    Dom.delegate(document, "click", "#communities-rail [data-communities-tab]", (e, btn) => {
      View.goToTab(btn.dataset.communitiesTab);
    });
    Dom.delegate(document, "click", "[data-communities-tab]:not(#communities-rail [data-communities-tab])", (e, btn) => {
      Router.go("communities");
      View.goToTab(btn.dataset.communitiesTab);
    });

    Dom.delegate(document, "click", "[data-search-suggest]", (e, btn) => {
      if (input) input.value = btn.dataset.searchSuggest;
      runSearch(btn.dataset.searchSuggest);
    });

    Dom.delegate(document, "click", "#catalog-filter button", (e, btn) => {
      AppState.catalogFilter = btn.dataset.catalog;
      for (const sib of btn.parentElement.children) sib.classList.toggle("active", sib === btn);
      renderCatalog();
    });

    Dom.delegate(document, "click", '[data-action="add-sub-row"]', (e, btn) => {
      bulkAdd([btn.dataset.sub]);
    });

    Dom.delegate(document, "click", '[data-action="remove-sub"]', (e, btn) => {
      AppState.removeSub(btn.dataset.sub);
      App.renderChips();
      App.markPending();
      View.render();
      Router.invalidate(["dashboard", "posts"]);
    });

    Dom.delegate(document, "change", '[data-action="toggle-active-sub"]', (e, input2) => {
      AppState.toggleSub(input2.dataset.sub);
      App.renderChips();
      App.markPending();
      renderLoaded();
    });

    Dom.delegate(document, "click", '[data-action="toggle-catalog-sub"]', (e, btn) => {
      const name = btn.dataset.sub;
      if (AppState.hasSub(name)) AppState.removeSub(name);
      else AppState.addSubs([name]);
      App.renderChips();
      App.markPending();
      renderCatalog();
    });

    Dom.delegate(document, "click", '[data-action="load-sphere"]', (e, btn) => {
      const key = btn.dataset.sphere;
      const subs = Seeds.expand([key]);
      bulkAdd(subs, Seeds.labelOf(key));
    });

    Dom.delegate(document, "click", '[data-action="load-bundle"]', (e, btn) => {
      const bundle = Seeds.BUNDLES.find((b) => b.key === btn.dataset.bundle);
      bulkAdd(Seeds.bundleSubs(btn.dataset.bundle), bundle ? bundle.label : "");
    });

    Dom.delegate(document, "click", '[data-action="add-all-results"]', () => {
      const names = (AppState.communitiesResults || []).slice(0, 10).map((r) => r.name);
      bulkAdd(names, "search results");
    });

    Dom.delegate(document, "click", '[data-action="similar"]', (e, btn) => {
      toggleSimilar(btn.dataset.sub);
    });

    Dom.delegate(document, "click", '[data-action="add-all-similar"]', (e, btn) => {
      const panel = document.querySelector(`[data-similar-for="${CSS.escape(btn.dataset.sub.toLowerCase())}"]`);
      const names = (panel && panel._similar) || [];
      bulkAdd(names, `communities like r/${btn.dataset.sub}`);
    });

    const allBtn = Dom.byId("loaded-subs-all");
    if (allBtn) {
      allBtn.addEventListener("click", () => {
        for (const s of AppState.knownSubs) AppState.activeSubs.add(s);
        AppState.persist();
        App.renderChips();
        App.markPending();
        renderLoaded();
      });
    }
    const noneBtn = Dom.byId("loaded-subs-none");
    if (noneBtn) {
      noneBtn.addEventListener("click", () => {
        AppState.activeSubs.clear();
        AppState.persist();
        App.renderChips();
        App.markPending();
        renderLoaded();
      });
    }
  };

  View.subtitle = function () {
    return `${AppState.knownSubs.length} loaded · ${Seeds.allSubs().length} in the catalog`;
  };

  Router.register("communities", {
    title: "Communities",
    subtitle: View.subtitle,
    mount: View.mount,
    render: View.render,
  });

  window.CommunitiesView = View;
})();
