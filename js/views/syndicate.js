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
  let sourceQuery = "";
  let suggestToken = 0;
  let listPaintTimer = null;
  let planSynIndex = 0;
  /* Article ids whose offline suggestion has already been upgraded with
   * live descriptions + archive uniqueness for this session. */
  const upgraded = new Set();

  /* How many headlines get a destination per suggest wave. Offline match
   * is cheap per item but hundreds of Discovery ranks still freeze the
   * tab — keep waves small and yield between them. The queue is
   * unmatched-first (not strength-sorted) so ranking the list for
   * display cannot starve progressive headlines at the bottom. */
  const AUTO_SUGGEST_CAP = 24;
  const AUTO_SUGGEST_WAVES = 6;
  const LIST_RENDER_CAP = 160;

  let globalsWired = false;
  let autoSuggestTimer = null;
  let planListSig = "";
  let statusTimer = 0;
  let statusPending = "";
  let statusLast = "";
  let statusLastAt = 0;

  /* Stable status line for both the desk and the dashboard card.
   * Progress callbacks used to rewrite the title of every finished feed
   * and every suggest wave, which made the UI flicker ("wave 1/3",
   * rotating source names). Throttle progress; apply finals immediately. */
  function setStatus(text, opts) {
    opts = opts || {};
    const msg = text == null ? "" : String(text);
    const apply = () => {
      statusPending = "";
      statusLast = msg;
      statusLastAt = Date.now();
      const nodes = [Dom.byId("syndicate-status"), Dom.byId("plan-syndicate-status")];
      for (const el of nodes) if (el) el.textContent = msg;
      paintDashPullButton();
    };
    if (opts.force || !msg) {
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = 0; }
      apply();
      return;
    }
    statusPending = msg;
    const elapsed = Date.now() - statusLastAt;
    if (elapsed >= 450 || statusLast === "") {
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = 0; }
      apply();
      return;
    }
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = 0;
      if (statusPending !== "") {
        const pending = statusPending;
        statusPending = "";
        setStatus(pending, { force: true });
      }
    }, 450 - elapsed);
  }

  function paintDashPullButton() {
    const busy = !!(Syndicate.pulling && Syndicate.pulling());
    const deskBtn = Dom.byId("syndicate-pull");
    if (deskBtn) {
      deskBtn.disabled = busy;
      if (!busy) deskBtn.textContent = "↻ Pull latest";
    }
    document.querySelectorAll('[data-action="plan-syn-pull"]').forEach((btn) => {
      btn.disabled = busy;
      btn.textContent = busy ? "Pulling…" : "↻ Pull latest";
    });
    const sBusy = !!(Syndicate.suggesting && Syndicate.suggesting());
    document.querySelectorAll('[data-action="plan-syn-suggest"]').forEach((btn) => {
      btn.disabled = sBusy || !Syndicate.articles().length;
      btn.textContent = sBusy ? "Suggesting…" : "Suggest";
    });
  }

  View.subtitle = function () {
    const n = filtered().length;
    const total = Syndicate.articles().length;
    const feeds = Syndicate.enabledFeeds().length;
    if (!total) return `${feeds} feed${feeds === 1 ? "" : "s"} ready`;
    if ((searchQuery || sourceQuery) && n !== total) {
      return `${Util.fmtNum(n)} of ${Util.fmtNum(total)} · ${feeds} feeds`;
    }
    return `${Util.fmtNum(total)} headline${total === 1 ? "" : "s"} · ${feeds} feeds`;
  };

  function applySearch(list) {
    const q = searchQuery.trim().toLowerCase();
    const src = sourceQuery.trim().toLowerCase();
    if (!q && !src) return list;
    return list.filter((a) => {
      if (src) {
        const haySrc = String(a.source || "").toLowerCase();
        if (haySrc.indexOf(src) === -1) return false;
      }
      if (!q) return true;
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
    const needArchive = [];
    const weak = [];
    const refreshWeak = opts.refreshWeak !== false;
    const wantArchive = opts.skipArchive !== true;
    for (const a of list) {
      const m = Syndicate.matchOf(a.id);
      if (!m) unmatched.push(a);
      else if (wantArchive && !m.archiveChecked) needArchive.push(a);
      else if (refreshWeak) {
        if (Syndicate.hasStrongDestination && !Syndicate.hasStrongDestination(a.id)) weak.push(a);
        else if (!Syndicate.hasStrongDestination && !(Syndicate.suggestionsOf(a.id, 1) || []).length) weak.push(a);
      }
    }
    return unmatched.concat(needArchive).concat(weak);
  }

  View.render = function () {
    renderFolders();
    renderList();
    renderDetail();
    paintSuggestButton();
    paintSourceList();
    View.paintPlanCarousel();
    const sub = Dom.byId("topbar-title-sub");
    if (sub && Router.current() === "syndicate") {
      sub.hidden = false;
      sub.textContent = View.subtitle();
    }
    const search = Dom.byId("syndicate-search");
    if (search && search.value !== searchQuery) search.value = searchQuery;
    const source = Dom.byId("syndicate-source");
    if (source && source.value !== sourceQuery) source.value = sourceQuery;
    /* Selecting a headline (or opening the view with one already
     * picked) should show destinations without a second click. */
    if (selectedId) {
      queueMicrotask(() => ensureSelectedMatched());
    }
  };

  function paintSourceList() {
    const list = Dom.byId("syndicate-source-list");
    if (!list || !Syndicate.sources) return;
    list.innerHTML = Syndicate.sources().slice(0, 40).map((s) =>
      `<option value="${esc(s.name)}"></option>`
    ).join("");
  }

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
    if (meta && list.length > LIST_RENDER_CAP) {
      const base = meta.textContent || `${Util.fmtNum(list.length)} articles`;
      meta.textContent = `${base} · showing top ${Util.fmtNum(LIST_RENDER_CAP)}`;
    }

    host.innerHTML = list.slice(0, LIST_RENDER_CAP).map((a) => {
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
               const posted = !!c.alreadyPosted;
               const score = !posted && c.score != null ? Math.round(c.score) : "";
               const title = posted
                 ? `Already posted on r/${name} — still listed so you can open the existing thread`
                 : (score !== "" ? `Fit ${score}` : "");
               return `<span class="syn-suggest${i === 0 && !posted ? " is-top" : ""}${posted ? " is-posted" : ""}"${title ? ` title="${esc(title)}"` : ""}>r/${esc(name)}${posted ? `<em class="syn-posted-tag">posted</em>` : (score !== "" ? `<em>${score}</em>` : "")}</span>`;
             }).join("")}
           </div>`;
      } else if (matchBusy === a.id) {
        tipHtml = `<div class="syn-suggests is-pending"><span class="meta">Matching…</span></div>`;
      } else if (cached) {
        tipHtml = `<div class="syn-suggests is-weak"><span class="meta">No strong destination</span></div>`;
      }
      const thumbInner = a.image
        ? `<img class="syn-thumb" src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
        : `<div class="syn-thumb syn-thumb-empty" aria-hidden="true">${esc((a.source || "?").slice(0, 1).toUpperCase())}</div>`;
      const thumb = a.link
        ? `<a class="syn-thumb-link" href="${esc(a.link)}" target="_blank" rel="noopener" title="Open article">${thumbInner}</a>`
        : thumbInner;
      const title = a.link
        ? `<a class="syn-title" href="${esc(a.link)}" target="_blank" rel="noopener" title="Open article">${esc(a.title)}</a>`
        : `<div class="syn-title">${esc(a.title)}</div>`;
      return `
        <div class="syn-card${active}" data-syn-id="${esc(a.id)}" role="button" tabindex="0">
          ${thumb}
          <div class="syn-card-body">
            <div class="syn-card-meta">
              <span class="syn-source-box">${esc(a.source || a.category || "Feed")}</span>
              ${when.rel ? `<span class="syn-time-box" title="${esc(when.abs)}">${esc(when.rel)}</span>` : ""}
              ${a.category ? `<span class="badge">${esc(a.category)}</span>` : ""}
            </div>
            ${title}
            ${a.summary ? `<div class="syn-sum">${esc(a.summary.slice(0, 140))}${a.summary.length > 140 ? "…" : ""}</div>` : ""}
            ${tipHtml || keyHtml}
          </div>
        </div>`;
    }).join("");
  }

  function renderDetail() {
    const host = Dom.byId("syndicate-detail");
    if (!host) return;
    const article = Syndicate.articles().find((a) => a.id === selectedId);
    host.innerHTML = articleDetailHtml(article);
  }

  function matchHtml(result, post) {
    const floor = (window.Discovery && Discovery.MIN_SUGGEST_SCORE != null)
      ? Discovery.MIN_SUGGEST_SCORE
      : (Syndicate.MIN_SUGGEST_SCORE || 35);
    const allCands = (result.candidates || []).slice();
    /* Legacy caches parked already-posted under blocked — fold them in. */
    for (const c of result.blocked || []) {
      if (c && c.alreadyPosted) allCands.push(c);
    }
    const cands = allCands
      .filter((c) => c.alreadyPosted || (c.score == null ? 0 : c.score) >= floor)
      .sort((a, b) => {
        const ap = a.alreadyPosted ? 1 : 0;
        const bp = b.alreadyPosted ? 1 : 0;
        if (ap !== bp) return ap - bp;
        return (b.score || 0) - (a.score || 0);
      });
    const blocked = (result.blocked || []).filter((c) => !(c && c.alreadyPosted));
    const spheres = (result.spheres || []).slice(0, 4);
    const sphereBit = spheres.length
      ? `<div class="syn-spheres">${spheres.map((s) =>
          `<span class="chip active">${esc(s.label || s.key)}${s.confidence != null ? `<span class="chip-meta">${Math.round(s.confidence)}%</span>` : ""}</span>`
        ).join("")}</div>`
      : "";

    if (!cands.length && !blocked.length) {
      return `${sphereBit}<p class="focus-status">No strong destination for this headline (need fit ≥ ${floor}). Try a related sphere from Communities, or Refresh match after Sync.</p>`;
    }

    const rows = cands.slice(0, 10).map((c) => {
      const name = c.name || c.key;
      const posted = !!c.alreadyPosted;
      const score = c.score != null ? Math.round(c.score) : (c.fit != null ? Math.round(c.fit) : "—");
      const reasons = (c.overlapTerms || []).slice(0, 4).map((t) =>
        typeof t === "string" ? t : (t.term || "")
      ).filter(Boolean);
      const ruleOk = !posted && c.rules && c.rules.rule && c.rules.ok;
      const ruleWarn = !posted && c.rules && c.rules.rule && !c.rules.ok && !c.rules.hard;
      const submit = (!posted && window.Crosspost && Crosspost.submitUrl)
        ? Crosspost.submitUrl(name, post)
        : (!posted && Util.buildSubmitUrl ? Util.buildSubmitUrl(name, post) : null);
      const loaded = window.AppState && AppState.hasSub && AppState.hasSub(name);
      const dup = posted && c.alreadyPosted.post;
      const dupSrc = posted
        ? (c.alreadyPosted.source === "archive" ? "on the subreddit already" : "in your loaded posts")
        : "";
      const dupLink = dup && (dup.permalink
        || (dup.id ? `https://www.reddit.com/r/${encodeURIComponent(name)}/comments/${encodeURIComponent(String(dup.id).replace(/^t3_/, ""))}/` : ""));
      const dupMeta = dup
        ? [dup.score != null ? `${Util.fmtNum(dup.score)} pts` : "", dup.created_utc ? Util.relTime(dup.created_utc) : "", dupSrc]
            .filter(Boolean).join(" · ")
        : dupSrc;
      return `
        <li class="syn-cand${posted ? " is-posted" : ""}">
          <div class="syn-cand-main">
            <a class="syn-cand-name" href="https://www.reddit.com/r/${encodeURIComponent(name)}/" target="_blank" rel="noopener">r/${esc(name)}</a>
            ${posted
              ? `<span class="badge bad" title="${esc(dupMeta || "Already posted on this subreddit")}">already on r/${esc(name)}</span>`
              : `<span class="badge accent">${esc(String(score))}</span>`}
            ${ruleOk ? `<span class="focus-sig focus-sig-rules is-ok" title="${esc((c.rules.rule && c.rules.rule.note) || "")}"><b>rules</b> ok</span>` : ""}
            ${ruleWarn ? `<span class="focus-sig focus-sig-rules is-warn" title="${esc((c.ruleReasons && c.ruleReasons[0]) || "")}"><b>rules</b> check</span>` : ""}
            ${loaded ? `<span class="badge info">loaded</span>` : ""}
          </div>
          ${posted
            ? `<p class="syn-cand-posted-note">This article is already posted to r/${esc(name)}${dupMeta ? ` · ${esc(dupMeta)}` : ""}. It stays listed so you can open the existing thread instead of re-submitting.</p>`
            : (reasons.length ? `<div class="syn-cand-terms">${reasons.map((t) => `<code>${esc(t)}</code>`).join(" ")}</div>` : "")}
          <div class="syn-cand-actions">
            ${dupLink ? `<a class="btn tiny ghost" href="${esc(dupLink)}" target="_blank" rel="noopener">Open existing</a>` : ""}
            ${submit ? `<a class="btn tiny primary" href="${esc(submit)}" target="_blank" rel="noopener">Submit link</a>` : ""}
            ${loaded || posted ? "" : `<button type="button" class="btn tiny ghost" data-action="syn-add-sub" data-sub="${esc(name)}">＋ Add</button>`}
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

    const archiveNote = result.archiveChecked
      ? `<p class="hint syn-archive-note">Checked the archive for rooms that forbid re-posting the same article URL (e.g. r/politics). Already-posted destinations stay listed, faded, so you can open the existing thread.</p>`
      : `<p class="hint syn-archive-note">Checking whether this URL is already on unique-link rooms…</p>`;

    return `
      ${sphereBit}
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

  /* Auto-match the selected headline offline first so opening Syndicate
   * does not stall on live About lookups. Upgrade with archive when the
   * user actually opens the card (or Open in Plan). */
  function ensureSelectedMatched() {
    const article = Syndicate.articles().find((a) => a.id === selectedId);
    if (!article) return;
    const cached = Syndicate.matchOf(article.id);
    if (!cached) {
      runMatch(article, { live: false, skipArchive: true });
      return;
    }
    if (!cached.archiveChecked && Router.current() === "syndicate") {
      /* Quiet upgrade only while on the desk — not during Plan carousel paint. */
      runMatch(article, { force: true, live: true, skipArchive: false, silent: true });
    }
  }

  function yieldToUi() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function suggestVisible(opts) {
    opts = opts || {};
    const cap = opts.cap || AUTO_SUGGEST_CAP;
    const waves = opts.waves == null ? AUTO_SUGGEST_WAVES : opts.waves;
    const queue = articlesForSuggest(opts);
    if (!queue.length && !Syndicate.articles().length) {
      if (opts.toast !== false) Util.toast("Pull headlines first, then suggest destinations.");
      return;
    }
    if (!queue.length) {
      if (opts.toast !== false) Util.toast("Destinations already suggested");
      return;
    }
    const token = ++suggestToken;
    paintSuggestButton();
    paintDashPullButton();
    let totalDone = 0;
    let lastRes = null;
    const attempted = new Set();
    try {
      for (let wave = 0; wave < waves; wave++) {
        if (token !== suggestToken) return;
        if (wave > 0) await yieldToUi();
        const batch = articlesForSuggest(opts)
          .filter((a) => opts.force || !attempted.has(a.id))
          .slice(0, cap);
        if (!batch.length) break;
        for (const a of batch) attempted.add(a.id);
        if (opts.announce !== false) {
          setStatus(waves > 1
            ? `Ranking destinations… ${wave + 1}/${waves}`
            : `Ranking destinations for ${batch.length} headline${batch.length === 1 ? "" : "s"}…`);
        }
        lastRes = await Syndicate.suggestMany(batch, {
          live: false,
          skipArchive: opts.skipArchive === true,
          archiveCap: opts.archiveCap == null ? 4 : opts.archiveCap,
          concurrency: 1,
          limit: 8,
          force: !!opts.force,
          refreshWeak: opts.refreshWeak !== false,
          onProgress: (done, total) => {
            if (token !== suggestToken) return;
            if (opts.announce !== false) {
              setStatus(waves > 1
                ? `Ranking destinations… ${wave + 1}/${waves} · ${done}/${total}`
                : `Ranking destinations… ${done}/${total}`);
            }
            scheduleListPaint();
            scheduleDashPaint();
          },
          onPartial: () => {
            if (token !== suggestToken) return;
            scheduleListPaint();
            scheduleDashPaint();
          },
        });
        if (token !== suggestToken) return;
        if (lastRes && lastRes.busy) break;
        totalDone += (lastRes && lastRes.done) || 0;
        if (!((lastRes && lastRes.done) > 0)) break;
        /* Let the browser paint between waves so Plan / rail stay responsive. */
        await yieldToUi();
      }
      if (token !== suggestToken) return;
      {
        const strong = filtered().filter((a) =>
          Syndicate.hasStrongDestination
            ? Syndicate.hasStrongDestination(a.id)
            : Syndicate.suggestionsOf(a.id, 1).length
        ).length;
        const n = filtered().filter((a) => Syndicate.matchOf(a.id)).length;
        setStatus(strong
          ? `${Util.fmtNum(strong)} with strong destinations · ${Util.fmtNum(n)} ranked`
          : n
            ? `${Util.fmtNum(n)} ranked · none cleared the fit floor yet`
            : (lastRes && lastRes.busy)
              ? "Still ranking…"
              : "No destinations found — try Sync communities, then Suggest again", { force: true });
      }
      if (opts.toast !== false && !(lastRes && lastRes.busy)) {
        Util.toast(totalDone
          ? `Suggested destinations for ${totalDone} headline${totalDone === 1 ? "" : "s"}`
          : "Destinations already suggested");
      }
      if (Router.current() === "syndicate") View.render();
      else View.paintPlanCarousel();
      ensureSelectedMatched();
    } catch (err) {
      setStatus((err && err.message) || String(err), { force: true });
      if (opts.toast !== false) Util.toast("Could not suggest destinations", "error");
    } finally {
      paintSuggestButton();
      paintDashPullButton();
    }
  }

  /* Soft background ranking after auto-pull or cache restore — never blocks
   * navigation. Continues in small waves while unmatched headlines remain. */
  function scheduleAutoSuggest(opts) {
    opts = opts || {};
    if (autoSuggestTimer) clearTimeout(autoSuggestTimer);
    autoSuggestTimer = setTimeout(() => {
      autoSuggestTimer = null;
      if (window.Demo && Demo.isActive() && !Syndicate.articles().length) return;
      if (!articlesForSuggest({}).length) {
        View.paintPlanCarousel();
        return;
      }
      suggestVisible({
        toast: false,
        announce: opts.announce === true,
        force: false,
        refreshWeak: false,
        cap: opts.cap || AUTO_SUGGEST_CAP,
        waves: opts.waves == null ? AUTO_SUGGEST_WAVES : opts.waves,
      }).then(() => {
        if (Syndicate.pulling && Syndicate.pulling()) return;
        const unmatched = articlesForSuggest({ refreshWeak: false })
          .filter((a) => {
            const m = Syndicate.matchOf(a.id);
            return !m || !m.archiveChecked;
          });
        if (unmatched.length) {
          scheduleAutoSuggest({ announce: false, waves: 3 });
        } else {
          View.paintPlanCarousel();
        }
      }).catch(() => {});
    }, opts.delay == null ? 80 : opts.delay);
  }

  async function openInPlan(article) {
    if (!article || !window.FocusView) return;
    let match = Syndicate.matchOf(article.id);
    /* Prefer the cached offline rank — re-matching live was freezing the
     * Plan tab when opening from Syndicate. Upgrade quietly in the
     * background after Focus paints. */
    if (!match) {
      matchBusy = article.id;
      if (Router.current() === "syndicate") View.render();
      else {
        /* Refresh sidebar match chrome if open, without a full desk paint. */
        const host = Dom.byId("syndicate-match");
        if (host) host.innerHTML = `<p class="hint">Ranking communities from the title and summary…</p>`;
        paintDashPullButton();
      }
      try {
        match = await Syndicate.match(article, {
          live: false,
          skipArchive: true,
          aboutBudget: 0,
          linkPriors: false,
        });
      } catch (err) {
        Util.toast((err && err.message) || String(err), "error");
        matchBusy = null;
        if (Router.current() === "syndicate") View.render();
        return;
      }
      matchBusy = null;
    }
    const draft = Syndicate.asPost(article);
    const related = match.related || {
      communities: [].concat(match.candidates || [], match.blocked || []),
      spheres: match.spheres || [],
      terms: match.keywords || Syndicate.keywords(article, 8),
    };
    FocusView.focusPost(draft, { related: related });
    if (window.Sidebar && Sidebar.isOpen && Sidebar.isOpen()) {
      try { Sidebar.close(); } catch (_) {}
    }
    /* Optional background upgrade — does not block Plan. */
    if (match.fromCache || !match.archiveChecked) {
      Syndicate.match(article, {
        force: true,
        live: true,
        skipArchive: false,
        aboutBudget: 16,
        liveTimeout: 5000,
      }).catch(() => {});
    }
  }

  /* Dashboard Recommend list: ranked headlines; tap opens the sidebar. */
  const DASH_LIST_CAP = 24;
  let dashPaintTimer = null;

  function recommendTitleQuery() {
    if (window.RecommendView && typeof RecommendView.titleQuery === "function") {
      return RecommendView.titleQuery();
    }
    const el = Dom.byId("recommend-title-search");
    return el ? String(el.value || "").trim().toLowerCase() : "";
  }

  /* Default: strong-destination top picks. With a title filter, search the
   * full desk so matches outside the top-pick window still surface. */
  function planArticles(limit) {
    const cap = limit == null ? DASH_LIST_CAP : limit;
    const q = recommendTitleQuery();
    if (!q) {
      return (Syndicate.topPicks && Syndicate.topPicks(cap)) || [];
    }
    const scoreOf = Syndicate.destinationScore
      ? (id) => Syndicate.destinationScore(id)
      : () => -2;
    return Syndicate.articles()
      .filter((a) => a && String(a.title || "").toLowerCase().indexOf(q) !== -1)
      .slice()
      .sort((a, b) => {
        const db = scoreOf(b.id);
        const da = scoreOf(a.id);
        if (db !== da) return db - da;
        return (b.published || 0) - (a.published || 0);
      })
      .slice(0, cap);
  }

  function scheduleDashPaint() {
    if (dashPaintTimer) return;
    dashPaintTimer = setTimeout(() => {
      dashPaintTimer = null;
      try { View.paintPlanCarousel(); } catch (_) {}
    }, 400);
  }

  function tipChipsHtml(articleId, limit) {
    const tips = Syndicate.suggestionsOf(articleId, limit || 3);
    if (!tips.length) return `<span class="meta">No strong destination yet</span>`;
    return tips.map((c, i) => {
      const name = c.name || c.key;
      const posted = !!c.alreadyPosted;
      const score = !posted && c.score != null ? Math.round(c.score) : "";
      return `<span class="syn-suggest${i === 0 && !posted ? " is-top" : ""}${posted ? " is-posted" : ""}">r/${esc(name)}${posted ? `<em class="syn-posted-tag">posted</em>` : (score !== "" ? `<em>${score}</em>` : "")}</span>`;
    }).join("");
  }

  function articleDetailHtml(article) {
    if (!article) {
      return `<div class="empty syn-detail-empty"><strong>Pick a headline</strong><p>Destinations come from the title and summary.</p></div>`;
    }
    const cached = Syndicate.matchOf(article.id);
    const keys = (cached && cached.keywords) || Syndicate.keywords(article, 10);
    const post = Syndicate.asPost(article);
    const when = whenBits(article);
    const hero = article.image
      ? (article.link
        ? `<a class="syn-article-hero" href="${esc(article.link)}" target="_blank" rel="noopener" title="Open article"><img src="${esc(article.image)}" alt="" referrerpolicy="no-referrer" /></a>`
        : `<div class="syn-article-hero"><img src="${esc(article.image)}" alt="" referrerpolicy="no-referrer" /></div>`)
      : "";
    const title = article.link
      ? `<h3 class="syn-article-title"><a href="${esc(article.link)}" target="_blank" rel="noopener" title="Open article">${esc(article.title)}</a></h3>`
      : `<h3 class="syn-article-title">${esc(article.title)}</h3>`;
    return `
      <article class="syn-article" data-syn-sidebar-id="${esc(article.id)}">
        ${hero}
        <div class="syn-article-kicker">
          <span class="syn-source-box">${esc(article.source || "")}</span>
          ${when.rel ? `<span class="syn-time-box" title="${esc(when.abs)}">${esc(when.rel)}</span>` : ""}
          ${article.category ? `<span class="badge">${esc(article.category)}</span>` : ""}
        </div>
        ${title}
        ${article.link ? `<a class="syn-article-link" href="${esc(article.link)}" target="_blank" rel="noopener">Read original ↗</a>` : ""}
        ${article.summary ? `<p class="syn-article-sum">${esc(article.summary)}</p>` : ""}
        <div class="syn-article-keys">
          <span class="group-label">Keywords</span>
          <div class="keyword-cloud">${keys.map((k) => `<span class="kw"><code>${esc(k)}</code></span>`).join("") || "<span class=\"meta\">none yet</span>"}</div>
        </div>
        <div class="syn-article-actions">
          <button type="button" class="btn ${cached ? "ghost" : "primary"}" data-action="syn-match" ${matchBusy === article.id ? "disabled" : ""}>
            ${matchBusy === article.id ? "Matching…" : cached ? "Refresh match" : "Match now"}
          </button>
          ${window.FocusView ? `<button type="button" class="btn primary" data-action="syn-focus">Open in Plan</button>` : ""}
        </div>
        <div id="syndicate-match" class="syn-match">
          ${cached
            ? matchHtml(cached, post)
            : `<p class="hint">${matchBusy === article.id
              ? "Ranking communities from the title and summary…"
              : "Destinations appear from keywords and civic spheres — or tap Match now."}</p>`}
        </div>
      </article>`;
  }

  function openArticleSidebar(article) {
    if (!article || !window.Sidebar) return;
    selectedId = article.id;
    Sidebar.open({
      id: "section-sidebar",
      title: article.source || "Headline",
      subtitle: article.title ? String(article.title).slice(0, 72) : "",
      content: articleDetailHtml(article),
      onMount: () => {
        /* Quiet upgrade once the sidebar is open. */
        ensureSelectedMatched();
      },
    });
  }

  View.paintPlanCarousel = function () {
    const host = Dom.byId("plan-syndicate-body");
    if (!host) return;
    paintDashPullButton();
    const q = recommendTitleQuery();
    const picks = planArticles(DASH_LIST_CAP);
    if (!picks.length) {
      planListSig = "";
      if (q && Syndicate.articles().length) {
        host.innerHTML = `<div class="empty plan-syn-empty">
          <strong>No title matches</strong>
          <p>Nothing in pulled headlines matches “${esc(q)}”.</p>
        </div>`;
      } else {
        host.innerHTML = `<div class="empty plan-syn-empty">
          <strong>No headlines yet</strong>
          <p>Tap <em>Pull latest</em> to read Politics and News feeds here.</p>
        </div>`;
      }
      return;
    }

    const sig = (q ? q + ":" : "") + picks.map((a) => a.id).join(",");
    /* Same set of headlines: refresh destination chips without replacing
     * the row buttons the user may be mid-tapping. */
    if (sig === planListSig && host.querySelector(".plan-syn-list")) {
      for (const a of picks) {
        const tips = host.querySelector(`[data-plan-syn-id="${CSS.escape(a.id)}"] [data-plan-syn-tips]`);
        if (tips) tips.innerHTML = tipChipsHtml(a.id, 3);
      }
      return;
    }
    planListSig = sig;

    host.innerHTML = `<div class="plan-syn-list" role="list">
      ${picks.map((a) => {
        const when = a.published ? Util.relTime(a.published) : "";
        const thumb = a.image
          ? `<img class="plan-syn-list-thumb" src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
          : `<div class="plan-syn-list-thumb is-empty" aria-hidden="true">${esc((a.source || "?").slice(0, 1).toUpperCase())}</div>`;
        return `
          <article class="plan-syn-row" data-plan-syn-id="${esc(a.id)}" role="listitem">
            <button type="button" class="plan-syn-row-main" data-action="plan-syn-open-sidebar" data-syn-id="${esc(a.id)}"
                    title="Open headline and destinations">
              ${thumb}
              <div class="plan-syn-row-copy">
                <div class="plan-syn-kicker">
                  <span class="syn-source-box">${esc(a.source || "")}</span>
                  ${when ? `<span class="syn-time-box">${esc(when)}</span>` : ""}
                </div>
                <h3 class="plan-syn-row-title">${esc(a.title)}</h3>
                <div class="syn-suggests" data-plan-syn-tips>${tipChipsHtml(a.id, 3)}</div>
              </div>
            </button>
            <div class="plan-syn-row-actions">
              <button type="button" class="btn primary small" data-action="plan-syn-open" data-syn-id="${esc(a.id)}">Open in Plan</button>
              <button type="button" class="btn small ghost" data-action="plan-syn-make-campaign" data-syn-id="${esc(a.id)}"
                      title="Start a theme campaign anchored on this headline">+ Campaign</button>
            </div>
          </article>`;
      }).join("")}
    </div>`;
  };

  async function pullFeeds() {
    if (Syndicate.pulling()) {
      setStatus("Already pulling feeds…", { force: true });
      Util.toast("Already pulling feeds");
      paintDashPullButton();
      return;
    }

    if (window.Demo && Demo.isActive()) {
      Syndicate.loadDemo();
      setStatus("Demo headlines loaded — ranking destinations offline.", { force: true });
      if (!selectedId && Syndicate.articles()[0]) selectedId = Syndicate.articles()[0].id;
      View.render();
      View.paintPlanCarousel();
      scheduleAutoSuggest({ announce: false, delay: 40 });
      return;
    }

    paintDashPullButton();
    const deskBtn = Dom.byId("syndicate-pull");
    if (deskBtn) { deskBtn.disabled = true; deskBtn.textContent = "Pulling…"; }
    setStatus("Reading feeds…", { force: true });

    try {
      const res = await Syndicate.pull({
        onProgress: (done, total) => {
          /* Counts only — rotating feed titles made the status line thrash. */
          setStatus(`Reading feeds… ${done}/${total}`);
        },
      });
      const errBit = res.errors.length
        ? ` · ${res.errors.length} feed${res.errors.length === 1 ? "" : "s"} failed`
        : "";
      if (res.keptCache) {
        setStatus(`Feeds failed${errBit} — keeping ${Util.fmtNum(res.articles.length)} cached headlines`, { force: true });
      } else {
        setStatus(res.articles.length
          ? `${Util.fmtNum(res.articles.length)} headlines from ${res.feedCount} feeds${errBit}`
          : `No headlines${errBit}`, { force: true });
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
      View.paintPlanCarousel();
      if (res.articles.length) {
        /* Quiet ranking — wave chatter stays off the status line. */
        scheduleAutoSuggest({ announce: false, delay: 40 });
      }
    } catch (err) {
      setStatus((err && err.message) || String(err), { force: true });
      Util.toast("Could not pull feeds", "error");
      View.render();
      View.paintPlanCarousel();
    } finally {
      if (deskBtn) { deskBtn.disabled = false; deskBtn.textContent = "↻ Pull latest"; }
      paintDashPullButton();
    }
  }

  View.pullFeeds = pullFeeds;
  View.openArticleSidebar = openArticleSidebar;

  View.mount = function () {
    View.wireGlobals();

    Dom.delegate(document, "click", "[data-syn-cat]", (e, btn) => {
      const cat = btn.dataset.synCat;
      Syndicate.setCategory(cat, !Syndicate.isCategoryOn(cat));
      View.render();
    });

    Dom.delegate(document, "click", "[data-syn-id]", (e, card) => {
      /* Title / thumb links open the article; don't steal that click. */
      if (e.target && e.target.closest && e.target.closest("a[href]")) return;
      selectedId = card.dataset.synId;
      View.render();
    });

    Dom.delegate(document, "keydown", "[data-syn-id]", (e, card) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target && e.target.closest && e.target.closest("a[href]")) return;
      e.preventDefault();
      selectedId = card.dataset.synId;
      View.render();
    });

    const pull = Dom.byId("syndicate-pull");
    if (pull) pull.addEventListener("click", () => pullFeeds());

    const suggestBtn = Dom.byId("syndicate-suggest");
    if (suggestBtn) {
      suggestBtn.addEventListener("click", () => suggestVisible({ toast: true, force: false }));
    }

    const search = Dom.byId("syndicate-search");
    if (search) {
      const debounced = Util.debounce(() => {
        searchQuery = search.value || "";
        View.render();
      }, 160);
      search.addEventListener("input", debounced);
    }

    const source = Dom.byId("syndicate-source");
    if (source) {
      const debounced = Util.debounce(() => {
        sourceQuery = source.value || "";
        View.render();
      }, 160);
      source.addEventListener("input", debounced);
      source.addEventListener("change", () => {
        sourceQuery = source.value || "";
        View.render();
      });
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
      scheduleAutoSuggest({ announce: false, delay: 60 });
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
      scheduleAutoSuggest({ announce: false, delay: 120 });
    }
    paintSuggestButton();
  };

  /* Dashboard list + pull — wired once from boot so Recommend works
   * before the user has opened a dedicated Syndicate desk. */
  View.wireGlobals = function () {
    if (globalsWired) return;
    globalsWired = true;

    Dom.delegate(document, "click", '[data-action="plan-syn-pull"]', () => {
      pullFeeds().catch(() => {});
    });
    Dom.delegate(document, "click", '[data-action="plan-syn-suggest"]', () => {
      suggestVisible({ toast: true, announce: false, force: false }).catch(() => {});
    });
    Dom.delegate(document, "click", '[data-action="plan-syn-open-sidebar"]', (e, el) => {
      const id = el.dataset.synId;
      const article = Syndicate.articles().find((a) => a && a.id === id);
      if (article) openArticleSidebar(article);
    });
    Dom.delegate(document, "click", '[data-action="plan-syn-open"]', (e, el) => {
      const id = el.dataset.synId;
      let article = id ? Syndicate.articles().find((a) => a && a.id === id) : null;
      if (!article) {
        const picks = planArticles(DASH_LIST_CAP);
        article = picks[0] || null;
      }
      if (article) openInPlan(article);
    });
    Dom.delegate(document, "click", '[data-action="plan-syn-make-campaign"]', (e, el) => {
      const id = el.dataset.synId;
      const article = id ? Syndicate.articles().find((a) => a && a.id === id) : null;
      if (!article || !window.Campaigns || !Campaigns.fromSyndicate) return;
      try {
        const existing = Campaigns.list().find((c) =>
          c.theme && c.theme.kind === "syndicate" && c.theme.articleId === article.id
        );
        const campaign = existing || Campaigns.fromSyndicate(article);
        Util.toast(existing
          ? `Already tracking “${campaign.name}”`
          : `Campaign “${campaign.name}” from headline`, existing ? "" : "ok");
        if (window.App) {
          if (App.populateCampaignSelectors) App.populateCampaignSelectors();
          if (App.publishCampaign) App.publishCampaign(campaign);
          if (App.openCampaign) App.openCampaign(campaign);
        }
      } catch (err) {
        Util.toast("Couldn't make a campaign: " + ((err && err.message) || err), "err");
      }
    });

    document.addEventListener("syndicate:pulled", () => {
      if (Router.current() === "syndicate") {
        try { View.render(); } catch (_) {}
      }
      try { View.paintPlanCarousel(); } catch (_) {}
      scheduleAutoSuggest({ announce: false, delay: 100 });
    });
  };

  Router.register("syndicate", {
    title: "Syndicate",
    subtitle: View.subtitle,
    mount: View.mount,
    render: View.render,
    enter: function () {
      /* Desk lives on the Recommend dashboard now — keep the route as a
       * soft redirect so old bookmarks still land somewhere useful. */
      if (window.DashboardView && DashboardView.goToRecommendPanel) {
        DashboardView.goToRecommendPanel("syndicate");
      } else if (window.AppState) {
        AppState.dashSection = "recommend";
        AppState.recommendPanel = "syndicate";
      }
      Router.go("dashboard");
      window.setTimeout(() => {
        try { View.paintPlanCarousel(); } catch (_) {}
        if (window.DashboardView && DashboardView.goToRecommendPanel) {
          try { DashboardView.goToRecommendPanel("syndicate"); } catch (_) {}
        }
      }, 60);
    },
  });

  window.SyndicateView = View;
})();
