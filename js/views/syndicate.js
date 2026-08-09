/* =====================================================================
 * SYNDICATE VIEW
 * ---------------------------------------------------------------------
 * Headlines in, communities out. Pull Politics/News feeds from the
 * curated Feedly catalog (or a fresh OPML), read keywords from each
 * title and summary, and rank where the article should be submitted.
 * ===================================================================== */
(function () {
  "use strict";

  const View = {};
  const esc = (s) => Util.escapeHtml(s == null ? "" : s);

  let selectedId = null;
  let matchBusy = null;
  let searchQuery = "";

  View.subtitle = function () {
    const n = filtered().length;
    const total = Syndicate.articles().length;
    const feeds = Syndicate.enabledFeeds().length;
    if (!total) return `${feeds} feed${feeds === 1 ? "" : "s"} ready`;
    if (searchQuery && n !== total) {
      return `${Util.fmtNum(n)} of ${Util.fmtNum(total)} · ${feeds} feeds`;
    }
    return `${Util.fmtNum(total)} headline${total === 1 ? "" : "s"} · ${feeds} feeds`;
  };

  function filtered() {
    const q = searchQuery.trim().toLowerCase();
    const list = Syndicate.articles();
    if (!q) return list;
    return list.filter((a) => {
      const hay = [a.title, a.summary, a.source, a.category, (Syndicate.keywords(a, 8) || []).join(" ")]
        .join(" ").toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  View.render = function () {
    renderFolders();
    renderList();
    renderDetail();
    const sub = Dom.byId("topbar-title-sub");
    if (sub && Router.current() === "syndicate") {
      sub.hidden = false;
      sub.textContent = View.subtitle();
    }
    const search = Dom.byId("syndicate-search");
    if (search && search.value !== searchQuery) search.value = searchQuery;
  };

  function renderFolders() {
    const host = Dom.byId("syndicate-folders");
    if (!host) return;
    const cats = Syndicate.categories();
    host.innerHTML = cats.map((cat) => {
      const on = Syndicate.isCategoryOn(cat);
      const count = Syndicate.catalog().filter((f) => f.category === cat).length;
      return `<button type="button" class="chip ${on ? "active" : ""}" data-syn-cat="${esc(cat)}"
                      aria-pressed="${on ? "true" : "false"}"
                      title="${on ? "Included" : "Excluded"} — ${count} feed${count === 1 ? "" : "s"}">
                ${esc(cat)}<span class="chip-meta">${count}</span>
              </button>`;
    }).join("");
  }

  function whenBits(a) {
    if (!a.published) return { rel: "", abs: "" };
    const rel = Util.relTime(a.published);
    const abs = new Date(a.published * 1000).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    return { rel, abs };
  }

  function renderList() {
    const host = Dom.byId("syndicate-list");
    const empty = Dom.byId("syndicate-empty");
    const meta = Dom.byId("syndicate-list-meta");
    if (!host) return;

    const list = filtered();
    const total = Syndicate.articles().length;
    if (meta) {
      if (!total) meta.textContent = "Pull feeds to load headlines";
      else if (searchQuery && list.length !== total) {
        meta.textContent = `${Util.fmtNum(list.length)} of ${Util.fmtNum(total)} match`;
      } else {
        meta.textContent = `${Util.fmtNum(total)} articles`;
      }
    }

    if (!list.length) {
      host.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        empty.innerHTML = total
          ? `<strong>No matches</strong><p>Nothing in the pulled headlines matches “${esc(searchQuery)}”.</p>`
          : `<strong>No headlines yet</strong><p>Tap <em>Pull latest</em> to read the enabled folders, or import a Feedly OPML. Yankees, Giants and other entertainment lists stay out.</p>`;
      }
      return;
    }
    if (empty) empty.hidden = true;

    host.innerHTML = list.map((a) => {
      const active = a.id === selectedId ? " is-active" : "";
      const when = whenBits(a);
      const keys = Syndicate.keywords(a, 4);
      const keyHtml = keys.length
        ? `<div class="syn-keys">${keys.map((k) => `<code>${esc(k)}</code>`).join(" ")}</div>`
        : "";
      const thumb = a.image
        ? `<img class="syn-thumb" src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
        : `<div class="syn-thumb syn-thumb-empty" aria-hidden="true">${esc((a.source || "?").slice(0, 1).toUpperCase())}</div>`;
      return `
        <button type="button" class="syn-card${active}" data-syn-id="${esc(a.id)}">
          ${thumb}
          <div class="syn-card-body">
            <div class="syn-card-meta">
              <span class="syn-source-box">${esc(a.source || a.category || "Feed")}</span>
              ${when.rel ? `<span class="syn-time-box" title="${esc(when.abs)}">${esc(when.rel)}</span>` : ""}
              ${a.category ? `<span class="badge">${esc(a.category)}</span>` : ""}
            </div>
            <div class="syn-title">${esc(a.title)}</div>
            ${a.summary ? `<div class="syn-sum">${esc(a.summary.slice(0, 140))}${a.summary.length > 140 ? "…" : ""}</div>` : ""}
            ${keyHtml}
          </div>
        </button>`;
    }).join("");
  }

  function renderDetail() {
    const host = Dom.byId("syndicate-detail");
    if (!host) return;
    const article = Syndicate.articles().find((a) => a.id === selectedId);
    if (!article) {
      host.innerHTML = `
        <div class="empty syn-detail-empty">
          <strong>Pick a headline</strong>
          <p>Keywords from the title and summary are matched against the same civic communities Where-next uses — including format rules (r/politics wants a fresh article link, not a text post).</p>
        </div>`;
      return;
    }

    const cached = Syndicate.matchOf(article.id);
    const keys = (cached && cached.keywords) || Syndicate.keywords(article, 10);
    const post = Syndicate.asPost(article);
    const when = whenBits(article);
    const hero = article.image
      ? `<div class="syn-article-hero"><img src="${esc(article.image)}" alt="" referrerpolicy="no-referrer" /></div>`
      : "";

    host.innerHTML = `
      <article class="syn-article">
        ${hero}
        <div class="syn-article-kicker">
          <span class="syn-source-box">${esc(article.source || "")}</span>
          ${when.rel ? `<span class="syn-time-box" title="${esc(when.abs)}">${esc(when.rel)}</span>` : ""}
          ${article.category ? `<span class="badge">${esc(article.category)}</span>` : ""}
        </div>
        <h3 class="syn-article-title">${esc(article.title)}</h3>
        ${article.link ? `<a class="syn-article-link" href="${esc(article.link)}" target="_blank" rel="noopener">Read original ↗</a>` : ""}
        ${article.summary ? `<p class="syn-article-sum">${esc(article.summary)}</p>` : ""}
        <div class="syn-article-keys">
          <span class="group-label">Keywords</span>
          <div class="keyword-cloud">${keys.map((k) => `<span class="kw"><code>${esc(k)}</code></span>`).join("") || "<span class=\"meta\">none yet</span>"}</div>
        </div>
        <div class="syn-article-actions">
          <button type="button" class="btn primary" data-action="syn-match" ${matchBusy === article.id ? "disabled" : ""}>
            ${matchBusy === article.id ? "Matching…" : cached ? "Refresh match" : "Where should this go?"}
          </button>
          ${window.FocusView ? `<button type="button" class="btn ghost" data-action="syn-focus">Open in Plan</button>` : ""}
        </div>
        <div id="syndicate-match" class="syn-match">
          ${cached ? matchHtml(cached, post) : "<p class=\"hint\">Match to see communities ranked by subject — blocked rooms (wrong format) are listed separately.</p>"}
        </div>
      </article>`;
  }

  function matchHtml(result, post) {
    const cands = result.candidates || [];
    const blocked = result.blocked || [];
    const spheres = (result.spheres || []).slice(0, 4);
    const sphereBit = spheres.length
      ? `<div class="syn-spheres">${spheres.map((s) =>
          `<span class="chip active">${esc(s.label || s.key)}${s.confidence != null ? `<span class="chip-meta">${Math.round(s.confidence)}%</span>` : ""}</span>`
        ).join("")}</div>`
      : "";

    if (!cands.length && !blocked.length) {
      return `${sphereBit}<p class="focus-status">No communities cleared the bar for this headline. Try loading a related sphere from Communities.</p>`;
    }

    const rows = cands.slice(0, 10).map((c) => {
      const name = c.name || c.key;
      const score = c.score != null ? Math.round(c.score) : (c.fit != null ? Math.round(c.fit) : "—");
      const reasons = (c.overlapTerms || []).slice(0, 4).map((t) =>
        typeof t === "string" ? t : (t.term || "")
      ).filter(Boolean);
      const ruleOk = c.rules && c.rules.rule && c.rules.ok;
      const ruleWarn = c.rules && c.rules.rule && !c.rules.ok && !c.rules.hard;
      const submit = (window.Crosspost && Crosspost.submitUrl)
        ? Crosspost.submitUrl(name, post)
        : Util.buildSubmitUrl ? Util.buildSubmitUrl(name, post) : null;
      const loaded = window.AppState && AppState.hasSub && AppState.hasSub(name);
      return `
        <li class="syn-cand">
          <div class="syn-cand-main">
            <a class="syn-cand-name" href="https://www.reddit.com/r/${encodeURIComponent(name)}/" target="_blank" rel="noopener">r/${esc(name)}</a>
            <span class="badge accent">${esc(String(score))}</span>
            ${ruleOk ? `<span class="focus-sig focus-sig-rules is-ok" title="${esc((c.rules.rule && c.rules.rule.note) || "")}"><b>rules</b> ok</span>` : ""}
            ${ruleWarn ? `<span class="focus-sig focus-sig-rules is-warn" title="${esc((c.ruleReasons && c.ruleReasons[0]) || "")}"><b>rules</b> check</span>` : ""}
            ${loaded ? `<span class="badge info">loaded</span>` : ""}
          </div>
          ${reasons.length ? `<div class="syn-cand-terms">${reasons.map((t) => `<code>${esc(t)}</code>`).join(" ")}</div>` : ""}
          <div class="syn-cand-actions">
            ${submit ? `<a class="btn tiny primary" href="${esc(submit)}" target="_blank" rel="noopener">Submit link</a>` : ""}
            ${loaded ? "" : `<button type="button" class="btn tiny ghost" data-action="syn-add-sub" data-sub="${esc(name)}">＋ Add</button>`}
          </div>
        </li>`;
    }).join("");

    const blockedBit = blocked.length ? `
      <details class="focus-blocked syn-blocked">
        <summary>${blocked.length} would reject this link format</summary>
        <ul class="focus-blocked-list">
          ${blocked.slice(0, 8).map((c) => `
            <li class="focus-blocked-row">
              <span class="focus-move-sub">r/${esc(c.name || c.key)}</span>
              <span class="badge bad">${esc((c.ruleReasons && c.ruleReasons[0]) || "against the rules")}</span>
            </li>`).join("")}
        </ul>
      </details>` : "";

    return `
      ${sphereBit}
      <ol class="syn-cands">${rows}</ol>
      ${blockedBit}`;
  }

  async function runMatch(article) {
    if (!article || matchBusy) return;
    matchBusy = article.id;
    View.render();
    try {
      const result = await Syndicate.match(article, {
        onPartial: () => {
          const host = Dom.byId("syndicate-match");
          if (host) host.innerHTML = matchHtml(Syndicate.matchOf(article.id) || { candidates: [], blocked: [], keywords: Syndicate.keywords(article) }, Syndicate.asPost(article));
        },
      });
      const host = Dom.byId("syndicate-match");
      if (host) host.innerHTML = matchHtml(result, result.post);
    } catch (err) {
      const host = Dom.byId("syndicate-match");
      if (host) host.innerHTML = `<p class="focus-status is-err">${esc((err && err.message) || err)}</p>`;
    } finally {
      matchBusy = null;
      const btn = document.querySelector('[data-action="syn-match"]');
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Refresh match";
      }
    }
  }

  async function openInPlan(article) {
    if (!article || !window.FocusView) return;
    let match = Syndicate.matchOf(article.id);
    if (!match) {
      matchBusy = article.id;
      View.render();
      try { match = await Syndicate.match(article); }
      catch (err) {
        Util.toast((err && err.message) || String(err), "error");
        matchBusy = null;
        View.render();
        return;
      }
      matchBusy = null;
    }
    const post = Syndicate.asPost(article);
    /* Re-adopt with suggested home filled from match. */
    const withHome = Syndicate.asPost(article);
    if (window.Analyze && Analyze.adopt) Analyze.adopt(withHome);
    const related = match.related || {
      communities: [].concat(match.candidates || [], match.blocked || []),
      spheres: match.spheres || [],
      terms: match.keywords || [],
    };
    FocusView.focusPost(withHome, { related: related });
  }

  async function pullFeeds() {
    const btn = Dom.byId("syndicate-pull");
    const status = Dom.byId("syndicate-status");
    if (Syndicate.pulling()) return;

    if (window.Demo && Demo.isActive()) {
      Syndicate.loadDemo();
      if (status) status.textContent = "Demo headlines loaded — matching stays offline.";
      if (!selectedId && Syndicate.articles()[0]) selectedId = Syndicate.articles()[0].id;
      View.render();
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = "Pulling…"; }
    if (status) status.textContent = "Reading feeds…";

    try {
      const res = await Syndicate.pull({
        onProgress: (done, total, title) => {
          if (status) status.textContent = `Reading ${done}/${total} · ${title}`;
        },
      });
      const errBit = res.errors.length
        ? ` · ${res.errors.length} feed${res.errors.length === 1 ? "" : "s"} failed`
        : "";
      if (status) {
        status.textContent = res.articles.length
          ? `${Util.fmtNum(res.articles.length)} headlines from ${res.feedCount} feeds${errBit}`
          : `No headlines${errBit}`;
      }
      if (res.errors.length) console.warn("[syndicate] feed errors:", res.errors);
      if (!selectedId && res.articles[0]) selectedId = res.articles[0].id;
      Util.toast(
        res.articles.length
          ? `Syndicate · ${res.articles.length} headlines`
          : "Syndicate · no headlines",
        res.errors.length && !res.articles.length ? "error" : ""
      );
    } catch (err) {
      if (status) status.textContent = (err && err.message) || String(err);
      Util.toast("Could not pull feeds", "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Pull latest"; }
      View.render();
    }
  }

  View.mount = function () {
    Dom.delegate(document, "click", "[data-syn-cat]", (e, btn) => {
      const cat = btn.dataset.synCat;
      Syndicate.setCategory(cat, !Syndicate.isCategoryOn(cat));
      View.render();
    });

    Dom.delegate(document, "click", "[data-syn-id]", (e, btn) => {
      selectedId = btn.dataset.synId;
      View.render();
    });

    const pull = Dom.byId("syndicate-pull");
    if (pull) pull.addEventListener("click", () => pullFeeds());

    const search = Dom.byId("syndicate-search");
    if (search) {
      const debounced = Util.debounce(() => {
        searchQuery = search.value || "";
        View.render();
      }, 160);
      search.addEventListener("input", debounced);
    }

    const file = Dom.byId("syndicate-opml");
    if (file) {
      file.addEventListener("change", async () => {
        const f = file.files && file.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          const n = Syndicate.importOpml(text);
          Util.toast(`Imported ${n.length} feeds from OPML (sports/entertainment skipped)`);
          Dom.byId("syndicate-status").textContent = `${n.length} feeds from ${f.name}`;
          View.render();
        } catch (err) {
          Util.toast((err && err.message) || String(err), "error");
        } finally {
          file.value = "";
        }
      });
    }

    Dom.delegate(document, "click", '[data-action="syn-match"]', () => {
      const article = Syndicate.articles().find((a) => a.id === selectedId);
      runMatch(article);
    });

    Dom.delegate(document, "click", '[data-action="syn-focus"]', () => {
      const article = Syndicate.articles().find((a) => a.id === selectedId);
      openInPlan(article);
    });

    Dom.delegate(document, "click", '[data-action="syn-add-sub"]', (e, btn) => {
      const sub = btn.dataset.sub;
      if (!sub || !window.AppState || !AppState.addSubs) return;
      AppState.addSubs([sub]);
      if (window.App && App.renderChips) App.renderChips();
      Util.toast(`Added r/${sub} — tap Go / Sync to load posts`);
      View.render();
    });

    if (window.Demo && Demo.isActive() && !Syndicate.articles().length) {
      Syndicate.loadDemo();
      selectedId = Syndicate.articles()[0] && Syndicate.articles()[0].id;
    }
  };

  Router.register("syndicate", {
    title: "Syndicate",
    subtitle: View.subtitle,
    mount: View.mount,
    render: View.render,
  });

  window.SyndicateView = View;
})();
