/* =====================================================================
 * SYNDICATE VIEW
 * ---------------------------------------------------------------------
 * Headlines in, communities out. Pull Politics/News feeds from the
 * curated catalog (or a fresh OPML), read keywords from each title and
 * summary, and rank where the article should be submitted.
 * ===================================================================== */
(function () {
  "use strict";

  const View = {};
  /* Decode leftover feed entities (&GT;, &AMP;, …) then escape for HTML.
   * Covers headlines pulled before makeArticle cleaned sources, and any
   * feed that still ships entities as literal text. */
  const esc = (s) => {
    const raw = s == null ? "" : String(s);
    const decoded = Util.decodeEntities ? Util.decodeEntities(raw) : raw;
    return Util.escapeHtml(decoded);
  };

  let selectedId = null;
  let matchBusy = null;
  let searchQuery = "";
  let suggestToken = 0;
  let listPaintTimer = null;
  /* Article ids whose offline suggestion has already been upgraded with
   * live descriptions + archive uniqueness for this session. */
  const upgraded = new Set();

  /* How many headlines get a destination per suggest wave. Offline match
   * is cheap; waves keep a 300-headline pull from monopolising the tab.
   * The queue is unmatched-first (not strength-sorted) so ranking the
   * list for display cannot starve progressive headlines at the bottom. */
  const AUTO_SUGGEST_CAP = 80;
  const AUTO_SUGGEST_WAVES = 4;

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

  function applySearch(list) {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((a) => {
      const hay = [a.title, a.summary, a.source, a.category, (Syndicate.keywords(a, 8) || []).join(" ")]
        .join(" ").toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  /* Display order: strongest destinations first. Never use this for the
   * suggest work queue — that starved unmatched headlines after #115. */
  function filtered() {
    const list = applySearch(Syndicate.articles());
    const scoreOf = Syndicate.destinationScore
      ? (id) => Syndicate.destinationScore(id)
      : () => -2;
    return list.slice().sort((a, b) => {
      const db = scoreOf(b.id);
      const da = scoreOf(a.id);
      if (db !== da) return db - da;
      return (b.published || 0) - (a.published || 0);
    });
  }

  /* Work queue for Suggest / auto-fill: newest unmatched first, then
   * matched-but-weak ("No strong destination"), then the rest. */
  function articlesForSuggest(opts) {
    opts = opts || {};
    const list = applySearch(Syndicate.articles())
      .slice()
      .sort((a, b) => (b.published || 0) - (a.published || 0));
    if (opts.force) return list;

    const unmatched = [];
    const weak = [];
    for (const a of list) {
      if (!Syndicate.matchOf(a.id)) unmatched.push(a);
      else if (Syndicate.hasStrongDestination && !Syndicate.hasStrongDestination(a.id)) weak.push(a);
      else if (!Syndicate.hasStrongDestination && !(Syndicate.suggestionsOf(a.id, 1) || []).length) weak.push(a);
    }
    return unmatched.concat(weak);
  }

  View.render = function () {
    renderFolders();
    renderList();
    renderDetail();
    paintSuggestButton();
    paintPlaybook();
    const sub = Dom.byId("topbar-title-sub");
    if (sub && Router.current() === "syndicate") {
      sub.hidden = false;
      sub.textContent = View.subtitle();
    }
    const search = Dom.byId("syndicate-search");
    if (search && search.value !== searchQuery) search.value = searchQuery;
    /* Selecting a headline (or opening the view with one already
     * picked) should show destinations without a second click. */
    if (selectedId) {
      queueMicrotask(() => ensureSelectedMatched());
    }
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
          : `<strong>No headlines yet</strong><p>Tap <em>Pull latest</em> to read the enabled folders, or import an OPML feed list. Sports and entertainment folders are skipped on import.</p>`;
      }
      return;
    }
    if (empty) empty.hidden = true;

    const matched = list.filter((a) => Syndicate.suggestionsOf(a.id, 1).length).length;
    if (meta && total && !searchQuery) {
      if (Syndicate.suggesting && Syndicate.suggesting()) {
        meta.textContent = `${Util.fmtNum(total)} articles · suggesting destinations…`;
      } else if (matched) {
        meta.textContent = `${Util.fmtNum(total)} articles · ${Util.fmtNum(matched)} with strong destinations · strongest first`;
      }
    }

    host.innerHTML = list.map((a) => {
      const active = a.id === selectedId ? " is-active" : "";
      const when = whenBits(a);
      const keys = Syndicate.keywords(a, 4);
      const keyHtml = keys.length
        ? `<div class="syn-keys">${keys.map((k) => `<code>${esc(k)}</code>`).join(" ")}</div>`
        : "";
      const cached = Syndicate.matchOf(a.id);
      const tips = Syndicate.suggestionsOf(a.id, 3);
      let tipHtml = "";
      if (tips.length) {
        tipHtml = `<div class="syn-suggests" title="Where this article should go">
             ${tips.map((c, i) => {
               const name = c.name || c.key;
               const score = c.score != null ? Math.round(c.score) : "";
               return `<span class="syn-suggest${i === 0 ? " is-top" : ""}">r/${esc(name)}${score !== "" ? `<em>${score}</em>` : ""}</span>`;
             }).join("")}
           </div>`;
      } else if (matchBusy === a.id) {
        tipHtml = `<div class="syn-suggests is-pending"><span class="meta">Matching…</span></div>`;
      } else if (cached) {
        tipHtml = `<div class="syn-suggests is-weak"><span class="meta">No strong destination</span></div>`;
      }
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
            ${tipHtml || keyHtml}
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
          <button type="button" class="btn ${cached ? "ghost" : "primary"}" data-action="syn-match" ${matchBusy === article.id ? "disabled" : ""}>
            ${matchBusy === article.id ? "Matching…" : cached ? "Refresh match" : "Matching…"}
          </button>
          ${window.FocusView ? `<button type="button" class="btn ghost" data-action="syn-focus">Open in Plan</button>` : ""}
        </div>
        <div id="syndicate-match" class="syn-match">
          ${cached
            ? matchHtml(cached, post)
            : `<p class="hint">${matchBusy === article.id
              ? "Ranking communities from the title and summary…"
              : "Destinations appear automatically from keywords and civic spheres."}</p>`}
        </div>
      </article>`;
  }

  function matchHtml(result, post) {
    const floor = (window.Discovery && Discovery.MIN_SUGGEST_SCORE != null)
      ? Discovery.MIN_SUGGEST_SCORE
      : (Syndicate.MIN_SUGGEST_SCORE || 35);
    const allCands = result.candidates || [];
    const cands = allCands.filter((c) => (c.score == null ? 0 : c.score) >= floor);
    const blocked = result.blocked || [];
    const spheres = (result.spheres || []).slice(0, 4);
    const sphereBit = spheres.length
      ? `<div class="syn-spheres">${spheres.map((s) =>
          `<span class="chip active">${esc(s.label || s.key)}${s.confidence != null ? `<span class="chip-meta">${Math.round(s.confidence)}%</span>` : ""}</span>`
        ).join("")}</div>`
      : "";

    if (!cands.length && !blocked.length) {
      return `${sphereBit}<p class="focus-status">No strong destination for this headline (need fit ≥ ${floor}). Try a related sphere from Communities, or Refresh match after Sync.</p>`;
    }

    const rows = cands.slice(0, 8).map((c) => {
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

    const already = blocked.filter((c) => c.alreadyPosted && c.alreadyPosted.post);
    const otherBlocked = blocked.filter((c) => !(c.alreadyPosted && c.alreadyPosted.post));
    const alreadyBit = already.length ? `
      <div class="syn-already">
        <p class="group-label">Already on the sub</p>
        <ul class="focus-blocked-list">
          ${already.slice(0, 8).map((c) => {
            const dup = c.alreadyPosted.post;
            const src = c.alreadyPosted.source === "archive" ? "full archive" : "your loaded posts";
            const link = dup.permalink
              || (dup.id ? `https://www.reddit.com/r/${encodeURIComponent(c.name || c.key)}/comments/${encodeURIComponent(String(dup.id).replace(/^t3_/, ""))}/` : "");
            const when = dup.created_utc ? Util.relTime(dup.created_utc) : "";
            const score = dup.score != null ? `${Util.fmtNum(dup.score)} pts` : "";
            return `
              <li class="focus-blocked-row syn-already-row">
                <span class="focus-move-sub">r/${esc(c.name || c.key)}</span>
                <span class="badge bad">already posted</span>
                <span class="meta">${esc([score, when, src].filter(Boolean).join(" · "))}</span>
                ${link ? `<a class="btn tiny ghost" href="${esc(link)}" target="_blank" rel="noopener">Open existing</a>` : ""}
              </li>`;
          }).join("")}
        </ul>
      </div>` : "";

    const blockedBit = otherBlocked.length ? `
      <details class="focus-blocked syn-blocked">
        <summary>${otherBlocked.length} would reject this link format</summary>
        <ul class="focus-blocked-list">
          ${otherBlocked.slice(0, 8).map((c) => `
            <li class="focus-blocked-row">
              <span class="focus-move-sub">r/${esc(c.name || c.key)}</span>
              <span class="badge bad">${esc((c.ruleReasons && c.ruleReasons[0]) || "against the rules")}</span>
            </li>`).join("")}
        </ul>
      </details>` : "";

    const archiveNote = result.archiveChecked
      ? `<p class="hint syn-archive-note">Checked the archive for rooms that forbid re-posting the same article URL (e.g. r/politics).</p>`
      : "";

    return `
      ${sphereBit}
      ${alreadyBit}
      <ol class="syn-cands">${rows}</ol>
      ${blockedBit}
      ${archiveNote}`;
  }

  function scheduleListPaint() {
    if (listPaintTimer) return;
    listPaintTimer = setTimeout(() => {
      listPaintTimer = null;
      if (Router.current() !== "syndicate") return;
      renderList();
      paintSuggestButton();
    }, 280);
  }

  function paintSuggestButton() {
    const btn = Dom.byId("syndicate-suggest");
    if (!btn) return;
    const busy = !!(Syndicate.suggesting && Syndicate.suggesting());
    btn.disabled = busy || !filtered().length;
    btn.textContent = busy ? "Suggesting…" : "Suggest destinations";
  }

  function paintPlaybook() {
    const sel = Dom.byId("syndicate-playbook");
    if (!sel || !Syndicate.playbook) return;
    const books = (window.MatchLex && MatchLex.playbooks)
      ? MatchLex.playbooks()
      : null;
    if (books && books.length) {
      const cur = sel.value;
      const html = books.map((b) =>
        `<option value="${esc(b.id)}" title="${esc(b.hint || "")}">${esc(b.label || b.id)}</option>`
      ).join("");
      if (sel.dataset.painted !== String(books.length)) {
        sel.innerHTML = html;
        sel.dataset.painted = String(books.length);
      }
      if (cur && !books.some((b) => b.id === cur)) {
        /* keep going */
      }
    }
    const want = Syndicate.playbook();
    if (sel.value !== want) sel.value = want;
  }

  /* Rank one article. Offline suggestions can already be on the card;
   * opening the detail upgrades with live descriptions + archive
   * uniqueness for unique_link rooms. */
  async function runMatch(article, opts) {
    opts = opts || {};
    if (!article) return null;
    if (matchBusy && matchBusy !== article.id && !opts.background) return null;
    if (!opts.background) matchBusy = article.id;
    if (!opts.silent) {
      const btn = document.querySelector('[data-action="syn-match"]');
      if (btn && selectedId === article.id) {
        btn.disabled = true;
        btn.textContent = "Matching…";
      }
    }
    try {
      const result = await Syndicate.match(article, {
        force: !!opts.force,
        live: opts.live !== false && !(window.Demo && Demo.isActive()),
        skipArchive: opts.skipArchive === true,
        limit: opts.limit || 12,
        onPartial: () => {
          if (selectedId !== article.id) return;
          const host = Dom.byId("syndicate-match");
          if (host) {
            host.innerHTML = matchHtml(
              Syndicate.matchOf(article.id) || { candidates: [], blocked: [], keywords: Syndicate.keywords(article) },
              Syndicate.asPost(article)
            );
          }
          scheduleListPaint();
        },
      });
      if (selectedId === article.id) {
        const host = Dom.byId("syndicate-match");
        if (host) host.innerHTML = matchHtml(result, result.post);
        const btn = document.querySelector('[data-action="syn-match"]');
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Refresh match";
          btn.classList.remove("primary");
          btn.classList.add("ghost");
        }
      }
      scheduleListPaint();
      return result;
    } catch (err) {
      if (selectedId === article.id) {
        const host = Dom.byId("syndicate-match");
        if (host) host.innerHTML = `<p class="focus-status is-err">${esc((err && err.message) || err)}</p>`;
      }
      return null;
    } finally {
      if (matchBusy === article.id) matchBusy = null;
    }
  }

  /* Auto-match the selected headline; upgrade a batch offline hit with
   * archive uniqueness when the user actually opens it. */
  function ensureSelectedMatched() {
    const article = Syndicate.articles().find((a) => a.id === selectedId);
    if (!article) return;
    const cached = Syndicate.matchOf(article.id);
    if (!cached) {
      runMatch(article, { live: true, skipArchive: false });
      return;
    }
    if (!cached.archiveChecked) {
      runMatch(article, { force: true, live: true, skipArchive: false, silent: true });
    }
  }

  async function suggestVisible(opts) {
    opts = opts || {};
    const cap = opts.cap || AUTO_SUGGEST_CAP;
    const waves = opts.waves == null ? AUTO_SUGGEST_WAVES : opts.waves;
    const queue = articlesForSuggest(opts);
    if (!queue.length && !Syndicate.articles().length) {
      Util.toast("Pull headlines first, then suggest destinations.");
      return;
    }
    if (!queue.length) {
      if (opts.toast !== false) Util.toast("Destinations already suggested");
      return;
    }
    const token = ++suggestToken;
    paintSuggestButton();
    const status = Dom.byId("syndicate-status");
    let totalDone = 0;
    let lastRes = null;
    const attempted = new Set();
    try {
      for (let wave = 0; wave < waves; wave++) {
        if (token !== suggestToken) return;
        const batch = articlesForSuggest(opts)
          .filter((a) => opts.force || !attempted.has(a.id))
          .slice(0, cap);
        if (!batch.length) break;
        for (const a of batch) attempted.add(a.id);
        if (status && opts.announce !== false) {
          status.textContent = waves > 1
            ? `Suggesting destinations · wave ${wave + 1}/${waves} · ${batch.length} headlines…`
            : `Suggesting destinations for ${batch.length} headline${batch.length === 1 ? "" : "s"}…`;
        }
        lastRes = await Syndicate.suggestMany(batch, {
          live: false,
          skipArchive: true,
          concurrency: 2,
          limit: 8,
          force: !!opts.force,
          refreshWeak: opts.refreshWeak !== false,
          onProgress: (done, total) => {
            if (token !== suggestToken) return;
            if (status) {
              status.textContent = waves > 1
                ? `Suggesting destinations · wave ${wave + 1}/${waves} · ${done}/${total}`
                : `Suggesting destinations ${done}/${total}…`;
            }
            scheduleListPaint();
          },
          onPartial: () => {
            if (token !== suggestToken) return;
            scheduleListPaint();
          },
        });
        if (token !== suggestToken) return;
        if (lastRes && lastRes.busy) break;
        totalDone += (lastRes && lastRes.done) || 0;
        if (!((lastRes && lastRes.done) > 0)) break;
      }
      if (token !== suggestToken) return;
      if (status) {
        const strong = filtered().filter((a) =>
          Syndicate.hasStrongDestination
            ? Syndicate.hasStrongDestination(a.id)
            : Syndicate.suggestionsOf(a.id, 1).length
        ).length;
        const n = filtered().filter((a) => Syndicate.matchOf(a.id)).length;
        status.textContent = strong
          ? `${Util.fmtNum(strong)} with strong destinations · ${Util.fmtNum(n)} ranked`
          : n
            ? `${Util.fmtNum(n)} ranked · none cleared the fit floor yet`
            : (lastRes && lastRes.busy)
              ? "Still suggesting…"
              : "No destinations found — try Sync communities, then Suggest again";
      }
      if (opts.toast !== false && !(lastRes && lastRes.busy)) {
        Util.toast(totalDone
          ? `Suggested destinations for ${totalDone} headline${totalDone === 1 ? "" : "s"}`
          : "Destinations already suggested");
      }
      View.render();
      ensureSelectedMatched();
    } catch (err) {
      if (status) status.textContent = (err && err.message) || String(err);
      Util.toast("Could not suggest destinations", "error");
    } finally {
      paintSuggestButton();
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
    /* Keep subreddit empty — this is not a Reddit post until someone
     * submits it. Match may still supply suggested_sub for Plan copy. */
    const draft = Syndicate.asPost(article);
    const related = match.related || {
      communities: [].concat(match.candidates || [], match.blocked || []),
      spheres: match.spheres || [],
      terms: match.keywords || [],
    };
    FocusView.focusPost(draft, { related: related });
  }

  async function pullFeeds() {
    const btn = Dom.byId("syndicate-pull");
    const status = Dom.byId("syndicate-status");
    if (Syndicate.pulling()) return;

    if (window.Demo && Demo.isActive()) {
      Syndicate.loadDemo();
      if (status) status.textContent = "Demo headlines loaded — suggesting destinations offline.";
      if (!selectedId && Syndicate.articles()[0]) selectedId = Syndicate.articles()[0].id;
      View.render();
      suggestVisible({ toast: false, announce: false });
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
        if (res.keptCache) {
          status.textContent = `Feeds failed${errBit} — keeping ${Util.fmtNum(res.articles.length)} cached headlines`;
        } else {
          status.textContent = res.articles.length
            ? `${Util.fmtNum(res.articles.length)} headlines from ${res.feedCount} feeds${errBit}`
            : `No headlines${errBit}`;
        }
      }
      if (res.errors.length) console.warn("[syndicate] feed errors:", res.errors);
      if (!selectedId && filtered()[0]) selectedId = filtered()[0].id;
      Util.toast(
        res.keptCache
          ? `Syndicate · kept ${res.articles.length} cached headlines`
          : res.articles.length
            ? `Syndicate · ${res.articles.length} headlines`
            : "Syndicate · no headlines",
        res.errors.length && !res.articles.length && !res.keptCache ? "error" : ""
      );
      View.render();
      if (res.articles.length) {
        suggestVisible({ toast: false, announce: true });
      }
    } catch (err) {
      if (status) status.textContent = (err && err.message) || String(err);
      Util.toast("Could not pull feeds", "error");
      View.render();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "↻ Pull latest"; }
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

    const suggestBtn = Dom.byId("syndicate-suggest");
    if (suggestBtn) {
      suggestBtn.addEventListener("click", () => suggestVisible({ toast: true, force: false }));
    }

    const playbook = Dom.byId("syndicate-playbook");
    if (playbook) {
      playbook.addEventListener("change", () => {
        Syndicate.setPlaybook(playbook.value || "default");
        const pb = window.MatchLex && MatchLex.playbook
          ? MatchLex.playbook(Syndicate.playbook())
          : null;
        Util.toast(pb
          ? `Playbook · ${pb.label}`
          : "Playbook updated");
        View.render();
        if (filtered().length) {
          suggestVisible({ toast: false, announce: true, force: true });
        }
      });
    }

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
          Util.toast(`Imported ${n.length} feeds from OPML`);
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
      runMatch(article, { force: true, live: true, skipArchive: false });
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
      selectedId = filtered()[0] && filtered()[0].id;
      queueMicrotask(() => suggestVisible({ toast: false, announce: false }));
    } else if (Syndicate.articles().length) {
      /* Restored from the 24h cache (or still in memory): pick the
       * strongest card and only re-suggest headlines that never matched. */
      if (!selectedId && filtered()[0]) selectedId = filtered()[0].id;
      const status = Dom.byId("syndicate-status");
      if (status && Syndicate.restoredFromCache && Syndicate.restoredFromCache()) {
        const when = Syndicate.cacheSavedAt && Syndicate.cacheSavedAt()
          ? Util.relTime(Math.floor(Syndicate.cacheSavedAt() / 1000))
          : "";
        status.textContent = `${Util.fmtNum(Syndicate.articles().length)} headlines from cache${when ? ` · saved ${when}` : ""} · kept 24h`;
      }
      queueMicrotask(() => {
        /* Use the unmatched-first queue, not the strength-sorted list —
         * otherwise the already-ranked cards fill the cap and the rest
         * of the pull never gets a destination. */
        if (articlesForSuggest({}).length) {
          suggestVisible({ toast: false, announce: false });
        }
      });
    }
    paintSuggestButton();
  };

  Router.register("syndicate", {
    title: "Syndicate",
    subtitle: View.subtitle,
    mount: View.mount,
    render: View.render,
  });

  window.SyndicateView = View;
})();
