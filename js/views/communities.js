/* =====================================================================
 * COMMUNITIES VIEW
 * ---------------------------------------------------------------------
 * Three jobs that used to be scattered or missing entirely:
 *
 *   Search    a real subreddit search — typeahead over cached names plus
 *             live autocomplete and full search — where every result can
 *             expand to show the communities most similar to it.
 *   Catalog   the curated civic / issue catalog, browsable, with
 *             starter bundles that no longer default to progressive-only,
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
  let pastedNames = null;

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

  /* A paste of several names is an add, not a search. Recognised only
     when every token looks like a subreddit reference and there are at
     least two of them, so an ordinary two-word topic ("tenant rights")
     still searches. */
  function parseSubList(text) {
    const raw = String(text || "").split(/[\s,;]+/).filter(Boolean);
    if (raw.length < 2) return null;
    const names = [];
    const seen = new Set();
    for (const tok of raw) {
      if (!/^\/?(r\/)?[A-Za-z0-9_]{2,30}\/?$/i.test(tok)) return null;
      /* Bare words are only a list if the paste marks them as subs. */
      if (!/r\//i.test(tok) && !/[0-9_]/.test(tok)) return null;
      const name = Util.normalizeSubName(tok);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    return names.length >= 2 ? names : null;
  }

  function renderPasteList(names) {
    const fresh = names.filter((s) => !AppState.hasSub(s));
    return `
      <div class="sub-result-toolbar">
        <span class="meta">${names.length} subreddit${names.length === 1 ? "" : "s"} in that list · ${fresh.length} not loaded yet</span>
        <button class="btn small primary" type="button" data-action="add-pasted" ${fresh.length ? "" : "disabled"}>
          ${fresh.length ? `＋ Add all ${fresh.length}` : "✓ All loaded"}
        </button>
      </div>
      <div class="chips" style="padding:var(--s-2) 0">
        ${names.map((s) => `<span class="chip ${AppState.hasSub(s) ? "active" : ""}">r/${esc(s)}</span>`).join("")}
      </div>`;
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

    const pasted = parseSubList(q);
    if (pasted) {
      searchToken++;
      pastedNames = pasted;
      host.innerHTML = renderPasteList(pasted);
      setSearchStatus("");
      return;
    }
    pastedNames = null;

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
            <span class="hint">Prefer one cohesive desk (or two related ones). “Everything” loads the whole issue catalog — Sync and matching both suffer.</span>
          </div>
          <div class="catalog-bundle-row">
            ${Seeds.BUNDLES.map((b) => {
              const subs = Seeds.bundleSubs(b.key);
              const missing = subs.filter((s) => !AppState.hasSub(s)).length;
              return `
                <button class="catalog-bundle" type="button"
                        data-action="${missing ? "load-bundle" : "unload-bundle"}" data-bundle="${esc(b.key)}"
                        title="${esc(b.description)}">
                  <span class="catalog-bundle-label">${esc(b.label)}</span>
                  <span class="catalog-bundle-meta">${subs.length} subs${missing ? ` · ${missing} new` : " · all loaded, tap to unload"}</span>
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
            <div class="catalog-card-actions">
              ${allLoaded ? "" : `
                <button class="btn small primary" type="button" data-action="load-sphere" data-sphere="${esc(key)}">
                  ＋ Load all ${subs.length}
                </button>`}
              ${loadedCount ? `
                <button class="btn small danger-soft" type="button" data-action="unload-sphere" data-sphere="${esc(key)}">
                  − Unload ${loadedCount}
                </button>` : ""}
            </div>
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

  /* Transient manager state. Not persisted: a selection is a gesture
     in progress, not a preference, and finding yesterday's half-made
     selection still ticked would be worse than starting clean. */
  let loadedFilter = "";
  const selection = new Set();

  /* Keep the desk tight: a few related issue spheres beat dozens of
     unrelated rooms. Past these soft caps, matching dilutes and Sync
     cost balloons (~2 archive calls per sub). */
  const COHESION_MAX_SPHERES = 3;
  const COHESION_SOFT_SUBS = 36;

  function issueKeysOf(name) {
    return Seeds.spheresOf(name).filter((k) =>
      !String(k).startsWith("state:") && !String(k).startsWith("demo:"));
  }

  function issueSphereSet(names) {
    const keys = new Set();
    for (const n of names || []) {
      for (const k of issueKeysOf(n)) keys.add(k);
    }
    return keys;
  }

  /* Issue-sphere chunks currently in inventory — one-tap unload targets.
     A sub in two spheres appears in both counts; unloading either sphere
     still only removes names that belong to that sphere. */
  function loadedIssueChunks() {
    const byKey = new Map();
    const other = [];
    for (const s of AppState.knownSubs) {
      const keys = issueKeysOf(s);
      if (!keys.length) {
        other.push(s);
        continue;
      }
      for (const k of keys) {
        let row = byKey.get(k);
        if (!row) {
          row = { key: k, label: Seeds.labelOf(k), names: [] };
          byKey.set(k, row);
        }
        row.names.push(s);
      }
    }
    const chunks = Array.from(byKey.values())
      .sort((a, b) => b.names.length - a.names.length || a.label.localeCompare(b.label));
    return { chunks: chunks, other: other };
  }

  function renderTrim() {
    const host = Dom.byId("loaded-trim");
    if (!host) return;
    const total = AppState.knownSubs.length;
    if (!total) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }

    const { chunks, other } = loadedIssueChunks();
    const sphereCount = chunks.length;
    const sprawling = sphereCount > COHESION_MAX_SPHERES || total > COHESION_SOFT_SUBS;

    host.hidden = false;
    host.innerHTML = `
      <div class="loaded-trim-head">
        <strong>Trim by theme</strong>
        <span class="hint">${sphereCount} issue theme${sphereCount === 1 ? "" : "s"} in inventory · Sync gives a quiet heads-up above ${((window.Refresh && Refresh.WARN_AT) || 12)}</span>
      </div>
      ${sprawling ? `<p class="loaded-trim-cohesion">
        Inventory spans ${sphereCount} themes (${total} subs). Matching works best with about ${COHESION_MAX_SPHERES} related desks and under ~${COHESION_SOFT_SUBS} communities — unload themes you are not campaigning on.
      </p>` : ""}
      <div class="loaded-trim-chips" role="group" aria-label="Unload theme chunks">
        ${chunks.map((c) => `
          <button type="button" class="chip loaded-trim-unload" data-action="unload-sphere" data-sphere="${esc(c.key)}"
                  title="Remove the ${c.names.length} loaded communities in ${esc(c.label)}">
            − ${esc(c.label)} · ${c.names.length}
          </button>`).join("")}
        ${other.length ? `
          <button type="button" class="chip loaded-trim-unload" data-action="unload-other"
                  title="Remove ${other.length} loaded communities not in the issue catalog">
            − Outside catalog · ${other.length}
          </button>` : ""}
        ${total >= 8 ? `
          <button type="button" class="chip loaded-trim-unload" data-action="unload-all-loaded"
                  title="Clear the whole inventory">
            − Remove all ${total}
          </button>` : ""}
      </div>`;
  }

  /* Filter matches the name or any sphere the sub belongs to, so
     "healthcare" narrows to that sphere's communities and the whole
     lot can then be selected and removed together. Loading a sphere
     is one tap; unloading it should not be forty. */
  function matchesFilter(name, q) {
    if (!q) return true;
    if (name.toLowerCase().includes(q)) return true;
    return Seeds.spheresOf(name).some((k) =>
      Seeds.labelOf(k.replace(/^(state|demo):/, "")).toLowerCase().includes(q));
  }

  function visibleSubs() {
    const q = loadedFilter.trim().toLowerCase();
    return AppState.knownSubs
      .filter((s) => matchesFilter(s, q))
      .sort((a, b) => a.localeCompare(b));
  }

  /* Drop names that are no longer loaded, so a removal cannot leave
     the count claiming more is selected than exists. */
  function pruneSelection() {
    if (!selection.size) return;
    const known = new Set(AppState.knownSubs.map((s) => s.toLowerCase()));
    for (const s of Array.from(selection)) {
      if (!known.has(s.toLowerCase())) selection.delete(s);
    }
  }

  /* Split from the grid because ticking a checkbox has to update the
     selection count and the action bar without replacing the checkbox
     the user is still touching. Re-rendering the whole grid on every
     tick meant the second and third taps landed on nodes that had
     already been thrown away, so selecting three subs selected one. */
  function renderToolbar() {
    const toolbar = Dom.byId("loaded-subs-toolbar");
    if (!toolbar) return;
    const total = AppState.knownSubs.length;
    if (!total) { toolbar.innerHTML = ""; return; }

    const subs = visibleSubs();
    const activeCount = AppState.knownSubs.filter((s) => AppState.activeSubs.has(s)).length;
    const allShownSelected = subs.length > 0 && subs.every((s) => selection.has(s));
    const due = Refresh.staleSubs(subs.filter((s) => AppState.activeSubs.has(s)));

    toolbar.innerHTML = `
        <div class="subman-bar">
          <input type="search" id="loaded-subs-filter" class="subman-filter"
                 placeholder="Filter by name or sphere…" aria-label="Filter loaded subreddits"
                 value="${esc(loadedFilter)}" autocomplete="off" />
          <span class="meta subman-count">
            ${loadedFilter ? `${subs.length} of ${total} shown` : `${total} loaded`} · ${activeCount} in the next fetch
          </span>
          <button class="btn small ghost" type="button" data-action="select-shown" ${subs.length ? "" : "disabled"}>
            ${allShownSelected ? "Deselect" : "Select"} ${loadedFilter ? `these ${subs.length}` : "all"}
          </button>
          ${due.length ? `
            <button class="btn small primary" type="button" data-sync="stale"
                    title="Sync ${due.length} out of date">
              Sync ${due.length} out of date
            </button>` : ""}
        </div>
        ${selection.size ? `
          <div class="subman-actions" role="group" aria-label="Actions for the selected subreddits">
            <strong>${selection.size} selected</strong>
            <button class="btn small primary" type="button" data-action="bulk-sync">Sync</button>
            <button class="btn small" type="button" data-action="bulk-enable">Include in fetch</button>
            <button class="btn small" type="button" data-action="bulk-disable">Exclude</button>
            <button class="btn small danger-soft" type="button" data-action="bulk-remove">Remove</button>
            <button class="btn small ghost" type="button" data-action="clear-selection">Clear</button>
          </div>` : ""}`;
  }

  function renderLoaded() {
    const host = Dom.byId("loaded-subs-grid");
    if (!host) return;
    pruneSelection();
    renderTrim();
    renderToolbar();

    if (!AppState.knownSubs.length) {
      host.innerHTML = Dom.emptyState({
        icon: "⌗",
        title: "No subreddits yet",
        body: "Start from one starter bundle or a single issue sphere — keep themes related so Sync stays light.",
        action: '<button class="btn primary" type="button" data-communities-tab="catalog">Browse the catalog</button>',
      });
      return;
    }

    const subs = visibleSubs();
    if (!subs.length) {
      host.innerHTML = `<p class="hint">Nothing matches “${esc(loadedFilter)}”. Filtering also matches sphere names, so try “healthcare” or a state.</p>`;
      return;
    }

    host.innerHTML = subs.map((s) => {
      const on = AppState.activeSubs.has(s);
      const picked = selection.has(s);
      const record = SubIndex.get(s);
      const posts = AppState.postsForSub(s).length;
      const age = AppState.syncAgeOf(s);
      const stale = age == null || age > Refresh.STALE_MS;
      return `
        <div class="loaded-sub ${on ? "" : "off"}${picked ? " picked" : ""}">
          <label class="loaded-sub-toggle">
            <input type="checkbox" data-action="select-sub" data-sub="${esc(s)}" ${picked ? "checked" : ""}
                   aria-label="Select r/${esc(s)}" />
            <span class="loaded-sub-name">r/${esc(s)}</span>
          </label>
          <div class="loaded-sub-meta">
            ${record && record.subscribers ? `${num(record.subscribers)} members · ` : ""}${posts ? `${num(posts)} posts loaded` : "no posts loaded"}
            · <span class="loaded-sub-age${stale ? " is-stale" : ""}">${esc(Refresh.ageLabel(s))}</span>
          </div>
          <div class="loaded-sub-actions">
            <button class="btn tiny ghost" type="button" data-sync="sub" data-sub="${esc(s)}"
                    aria-label="Sync r/${esc(s)}" title="Re-read r/${esc(s)} on its own, without touching the others">↻</button>
            <button class="btn tiny ${on ? "" : "ghost"}" type="button" data-action="toggle-active-sub" data-sub="${esc(s)}"
                    aria-pressed="${on}" title="${on ? "Included in the next fetch" : "Excluded from the next fetch"}">${on ? "On" : "Off"}</button>
            <button class="btn tiny danger-soft" type="button" data-action="remove-sub" data-sub="${esc(s)}" aria-label="Remove r/${esc(s)}">Remove</button>
          </div>
        </div>`;
    }).join("");
  }

  /* Every mutation from the manager lands here: one persist, one chip
     repaint, one invalidation, however many subs moved. */
  function afterSubChange(message) {
    App.renderChips();
    App.markPending(null, { scope: "subs" });
    Router.invalidate(["dashboard", "posts"]);
    View.render();
    if (message) Util.toast(message);
  }

  /* ==================================================================
   * BULK ADD
   * ================================================================== */

  async function bulkAdd(names, label) {
    const incoming = (names || []).filter(Boolean);
    const fresh = incoming.filter((s) => !AppState.hasSub(s));
    if (!fresh.length) {
      Util.toast(`Every sub${label ? ` in ${label}` : ""} was already in your dashboard`);
      return;
    }

    const projectedTotal = AppState.knownSubs.length + fresh.length;
    const beforeSpheres = issueSphereSet(AppState.knownSubs);
    const afterSpheres = issueSphereSet(AppState.knownSubs.concat(fresh));
    const newThemes = Array.from(afterSpheres).filter((k) => !beforeSpheres.has(k));
    const sprawl =
      afterSpheres.size > COHESION_MAX_SPHERES ||
      projectedTotal > COHESION_SOFT_SUBS ||
      fresh.length >= 24;

    if (sprawl) {
      const themeBit = afterSpheres.size > COHESION_MAX_SPHERES
        ? `This would span ${afterSpheres.size} issue themes`
        : `Inventory would grow to ${projectedTotal} communities`;
      const detail = [
        `${themeBit}. Matching stays sharper with about ${COHESION_MAX_SPHERES} related desks and under ~${COHESION_SOFT_SUBS} communities.`,
        newThemes.length
          ? `New themes: ${newThemes.slice(0, 6).map((k) => Seeds.labelOf(k)).join(", ")}${newThemes.length > 6 ? "…" : ""}`
          : "",
      ].filter(Boolean).join(" ");
      const ok = await Util.confirm({
        title: `Add ${fresh.length} communities?`,
        body: label
          ? `Load ${fresh.length} new subreddits from ${label}.`
          : `Load ${fresh.length} new subreddits into your dashboard.`,
        detail: detail,
        confirmLabel: `Add ${fresh.length}`,
        cancelLabel: "Keep it tight",
        tone: "info",
      });
      if (!ok) return;
    }

    const added = AppState.addSubs(incoming);
    App.renderChips();
    App.markPending(null, { scope: "subs" });
    View.render();
    Router.invalidate(["dashboard", "posts"]);
    if (added.length) {
      Util.toast(
        `Added ${added.length} subreddit${added.length === 1 ? "" : "s"}${label ? ` from ${label}` : ""} — tap Sync to load their posts`
      );
    }
    /* Warm a short head of the index only — full-catalog metadata for
     * dozens of new rooms is not worth the about.json storm. */
    const warm = added.slice(0, 24);
    if (warm.length) {
      SubIndex.ensure(warm, { limit: 20, concurrency: 2 }).then(() => {
        Discovery.invalidateSpheres();
        if (Router.current() === "communities") View.render();
      }).catch(() => {});
    }
  }

  /* The mirror of bulkAdd. Only counts what was actually loaded, so a
     sphere half of which you never had does not claim to have removed
     the other half. */
  async function bulkRemove(names, label) {
    const loaded = (names || []).filter((s) => AppState.hasSub(s));
    if (!loaded.length) {
      Util.toast(`Nothing from ${label || "that group"} is loaded`);
      return;
    }
    if (loaded.length > 1) {
      const ok = await Util.confirm({
        title: `Remove ${loaded.length} communities?`,
        body: label
          ? `Unload ${loaded.length} subreddits from ${label}.`
          : `Unload ${loaded.length} subreddits from your dashboard.`,
        detail: "Their loaded posts go with them.",
        confirmLabel: `Remove ${loaded.length}`,
        cancelLabel: "Keep them",
        tone: "warn",
      });
      if (!ok) return;
    }
    const removed = AppState.removeSubs(loaded);
    selection.clear();
    afterSubChange(`Removed ${removed.length} subreddit${removed.length === 1 ? "" : "s"}${label ? ` from ${label}` : ""}`);
  }

  /* ==================================================================
   * VIEW LIFECYCLE
   * ================================================================== */

  function paintTabs() {
    const active = AppState.communitiesTab || "search";
    Dom.paintRail("communities-rail", "communities-tab", active, "comm-sec-", "#view-communities .communities-section");
  }

  View.render = function () {
    paintTabs();
    const tab = AppState.communitiesTab || "search";
    if (tab === "catalog") renderCatalog();
    else if (tab === "loaded") renderLoaded();
    else if (tab === "profiles") {
      /* Audience fingerprints moved here from the dashboard, so every
       * community-shaped surface is behind the one Communities button. */
      if (window.UI && UI.renderSubProfiles) UI.renderSubProfiles(AppState.subProfiles);
    }
    else if (!AppState.communitiesQuery) {
      const host = Dom.byId("sub-search-results");
      if (host && !host.innerHTML.trim()) host.innerHTML = renderSearchIdle();
    }
  };

  View.goToTab = function (tab) {
    AppState.communitiesTab = tab;
    View.render();
    Dom.revealRailTab("communities-rail", "communities-tab", tab);
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

  /* Overflow chips and sprawling inventories land on Loaded, where
   * theme unload is one tap — not buried behind Catalog browsing. */
  View.openLoaded = function () {
    Router.go("communities");
    View.goToTab("loaded");
    const trim = Dom.byId("loaded-trim");
    if (trim && !trim.hidden) {
      try { trim.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (_) {}
    }
  };

  View.mount = function () {
    /* Large inventories: first Communities visit opens Loaded so
     * trim-by-theme is immediate. Later tab picks are left alone. */
    if (!View._landedLoaded && AppState.knownSubs.length >= 12 && AppState.communitiesTab === "search") {
      View._landedLoaded = true;
      AppState.communitiesTab = "loaded";
    }

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

    Dom.wireRail("communities-rail", "communities-tab", View.goToTab);
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
      App.markPending(null, { scope: "subs" });
      View.render();
      Router.invalidate(["dashboard", "posts"]);
    });

    Dom.delegate(document, "click", '[data-action="toggle-active-sub"]', (e, btn) => {
      AppState.toggleSub(btn.dataset.sub);
      App.renderChips();
      App.markPending(null, { scope: "subs" });
      renderLoaded();
    });

    /* ---- the loaded-subs manager ---- */

    Dom.delegate(document, "input", "#loaded-subs-filter", (e, el) => {
      loadedFilter = el.value;
      const at = el.selectionStart;
      renderLoaded();
      /* renderLoaded replaces the toolbar, so put the caret back or
         every keystroke would jump it to the end of the field. */
      const next = Dom.byId("loaded-subs-filter");
      if (next) { next.focus(); try { next.setSelectionRange(at, at); } catch (_) {} }
    });

    /* Only the toolbar and this one row repaint. The grid stays put so
       the next tick lands on a checkbox that still exists. */
    Dom.delegate(document, "change", '[data-action="select-sub"]', (e, input2) => {
      const name = input2.dataset.sub;
      if (input2.checked) selection.add(name); else selection.delete(name);
      const row = input2.closest(".loaded-sub");
      if (row) row.classList.toggle("picked", input2.checked);
      renderToolbar();
    });

    Dom.delegate(document, "click", '[data-action="select-shown"]', () => {
      const shown = visibleSubs();
      const allPicked = shown.length > 0 && shown.every((s) => selection.has(s));
      for (const s of shown) {
        if (allPicked) selection.delete(s); else selection.add(s);
      }
      renderLoaded();
    });

    Dom.delegate(document, "click", '[data-action="clear-selection"]', () => {
      selection.clear();
      renderLoaded();
    });

    /* Fetch exactly the ticked subs. The bar already lets someone
       narrow to a sphere and select it in one tap, so this is the
       shortest route to "re-read just the housing communities". */
    Dom.delegate(document, "click", '[data-action="bulk-sync"]', () => {
      const names = Array.from(selection);
      if (!names.length) return;
      /* Excluded subs are excluded from fetching, so syncing one would
         quietly contradict the switch the user set. */
      const fetchable = names.filter((s) => AppState.activeSubs.has(s));
      if (!fetchable.length) {
        Util.toast("All of those are excluded from fetching. Include them first.");
        return;
      }
      const held = names.length - fetchable.length;
      Refresh.subs(fetchable, {
        label: fetchable.length === 1 ? "r/" + fetchable[0] : `${fetchable.length} selected`,
      }).then(() => {
        if (held) Util.toast(`${held} of those are excluded from fetching, so they were skipped.`);
        renderLoaded();
      });
    });

    Dom.delegate(document, "click", '[data-action="bulk-enable"]', () => {
      const n = AppState.setActive(Array.from(selection), true);
      afterSubChange(n ? `${n} subreddit${n === 1 ? "" : "s"} back in the next fetch` : "Those were already included");
    });

    Dom.delegate(document, "click", '[data-action="bulk-disable"]', () => {
      const n = AppState.setActive(Array.from(selection), false);
      afterSubChange(n ? `${n} subreddit${n === 1 ? "" : "s"} held out of the next fetch` : "Those were already excluded");
    });

    Dom.delegate(document, "click", '[data-action="bulk-remove"]', () => {
      const names = Array.from(selection);
      if (!names.length) return;
      (async () => {
        if (names.length > 1) {
          const ok = await Util.confirm({
            title: `Remove ${names.length} communities?`,
            body: `Unload the ${names.length} selected subreddits from your dashboard.`,
            detail: "Their loaded posts go with them.",
            confirmLabel: `Remove ${names.length}`,
            cancelLabel: "Keep them",
            tone: "warn",
          });
          if (!ok) return;
        }
        const removed = AppState.removeSubs(names);
        selection.clear();
        afterSubChange(`Removed ${removed.length} subreddit${removed.length === 1 ? "" : "s"}`);
      })().catch(() => {});
    });

    Dom.delegate(document, "click", '[data-action="toggle-catalog-sub"]', (e, btn) => {
      const name = btn.dataset.sub;
      if (AppState.hasSub(name)) AppState.removeSub(name);
      else AppState.addSubs([name]);
      App.renderChips();
      App.markPending(null, { scope: "subs" });
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

    /* The inverse of loading a sphere. Its absence was the whole
       complaint: one tap put forty subs in, and taking them out again
       meant forty more. */
    Dom.delegate(document, "click", '[data-action="unload-sphere"]', (e, btn) => {
      bulkRemove(Seeds.expand([btn.dataset.sphere]), Seeds.labelOf(btn.dataset.sphere));
    });

    Dom.delegate(document, "click", '[data-action="unload-bundle"]', (e, btn) => {
      const bundle = Seeds.BUNDLES.find((b) => b.key === btn.dataset.bundle);
      bulkRemove(Seeds.bundleSubs(btn.dataset.bundle), bundle ? bundle.label : "");
    });

    Dom.delegate(document, "click", '[data-action="unload-other"]', () => {
      const other = loadedIssueChunks().other;
      bulkRemove(other, "outside the issue catalog");
    });

    Dom.delegate(document, "click", '[data-action="unload-all-loaded"]', () => {
      bulkRemove(AppState.knownSubs.slice(), "your whole inventory");
    });

    Dom.delegate(document, "click", '[data-action="add-pasted"]', () => {
      bulkAdd(pastedNames || [], "your list");
      if (pastedNames) runSearch(pastedNames.map((s) => "r/" + s).join(" "));
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
