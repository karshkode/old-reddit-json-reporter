/* ======================================================================
 * FOCUS A POST — the first thing on the Summary tab
 * ----------------------------------------------------------------------
 * The rest of the dashboard answers "how are my communities doing".
 * This answers the question people actually turn up with, which is
 * about one post: I have this thing, where does it go next?
 *
 * It takes a post from the inventory or a pasted link, hands it to
 * NextMove, and prints the answer as a place and a time with a reason
 * attached. One lead move up front, the runners-up under it, and the
 * communities that matched but have nothing loaded kept separately —
 * those are unknowns, not options, and mixing them in would let an
 * unmeasured community outrank a measured one on nothing at all.
 *
 * Ranking is not free: matching one post is a bounded run of about.json
 * reads. So it is cached per post for the life of the tab, keyed on the
 * loaded data too, and the offline pass paints before the network pass
 * refines it.
 * ====================================================================== */

(function () {
  "use strict";

  const View = {};
  const KEY = "rj.focusPost";

  /* postId -> { signature, result }. Signature covers the loaded data,
     since the timing half of every answer is read off it. */
  const cache = new Map();

  let focusId = null;
  let timing = null;
  let dataSignature = "";
  let busy = false;
  let lastError = "";
  let suggestIndex = -1;

  const esc = (s) => Util.escapeHtml(s == null ? "" : String(s));

  function trunc(s, n) {
    const t = String(s == null ? "" : s);
    return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
  }

  function host() { return document.getElementById("focus-body"); }

  /* ------------------------------------------------------------------
   * THE FOCUSED POST
   * ------------------------------------------------------------------ */

  function findPost(id) {
    if (!id || !window.AppState) return null;
    return AppState.posts.find((p) => p && p.id === id) || null;
  }

  function focused() { return findPost(focusId); }

  View.set = function (id) {
    focusId = id || null;
    lastError = "";
    try {
      if (focusId) localStorage.setItem(KEY, focusId);
      else localStorage.removeItem(KEY);
    } catch (_) {}
    render();
    if (focusId) rank();
  };

  View.current = function () { return focused(); };

  /* ------------------------------------------------------------------
   * RANKING
   * ------------------------------------------------------------------ */

  function resultFor(post) {
    const hit = cache.get(post.id);
    return hit && hit.signature === dataSignature ? hit.result : null;
  }

  /* Communities the content is already in are not suggestions. The
     cheap local half of what the analyse dialog does — no network, and
     it covers the communities the user actually tracks. */
  function alreadyIn(post) {
    const out = [String(post.subreddit || "").toLowerCase()];
    if (window.Analyze && Analyze.findLocally) {
      for (const p of Analyze.findLocally(post)) {
        out.push(String(p.subreddit || "").toLowerCase());
      }
    }
    return out.filter(Boolean);
  }

  async function rank() {
    const post = focused();
    if (!post || busy) return;
    if (resultFor(post)) { render(); return; }

    busy = true;
    lastError = "";
    render();

    const signature = dataSignature;
    try {
      const result = await NextMove.rank(post, {
        timing: timing,
        exclude: alreadyIn(post),
        live: !(window.Demo && Demo.isActive()),
        onPartial: (partial) => {
          /* Paint the offline answer immediately. The network pass only
             sharpens it, and staring at a spinner while forty about.json
             reads land is the worse trade. */
          if (focusId !== post.id) return;
          cache.set(post.id, { signature: signature, result: partial });
          render();
        },
      });
      cache.set(post.id, { signature: signature, result: result });
    } catch (err) {
      lastError = (err && err.message) || String(err);
    } finally {
      busy = false;
      render();
    }
  }

  /* ------------------------------------------------------------------
   * PICKING
   * ------------------------------------------------------------------ */

  /* Posts worth offering before anything is typed: what the user just
     brought in, then their best performers. Imported posts first
     because someone who pasted a link two minutes ago is very likely
     still working on it. */
  function suggestions(query) {
    const posts = (window.AppState && AppState.posts) || [];
    const q = String(query || "").trim().toLowerCase();

    if (!q) {
      const imported = posts.filter((p) => p.imported);
      const rest = posts.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
      return Util.uniqBy(imported.concat(rest), (p) => p.id).slice(0, 6);
    }

    const scored = [];
    for (const p of posts) {
      const title = String(p.title || "").toLowerCase();
      const sub = String(p.subreddit || "").toLowerCase();
      let rank = -1;
      if (title.startsWith(q)) rank = 0;
      else if (title.includes(q)) rank = 1;
      else if (sub.includes(q)) rank = 2;
      else if (String(Util.postBody(p, 400) || "").toLowerCase().includes(q)) rank = 3;
      if (rank >= 0) scored.push({ p: p, rank: rank });
    }
    scored.sort((a, b) => a.rank - b.rank || (b.p.score || 0) - (a.p.score || 0));
    return scored.slice(0, 8).map((s) => s.p);
  }

  function renderSuggestions() {
    const box = document.getElementById("focus-suggest");
    const input = document.getElementById("focus-input");
    if (!box || !input) return;

    const q = input.value;
    const link = window.Analyze && Analyze.looksLikePost(q);
    const list = link ? [] : suggestions(q);
    suggestIndex = -1;

    if (!link && !list.length) {
      box.innerHTML = `<p class="focus-suggest-empty">${q.trim()
        ? "Nothing in your posts matches that. Paste a Reddit link to bring a new post in."
        : "No posts loaded yet."}</p>`;
      box.hidden = false;
      input.setAttribute("aria-expanded", "true");
      return;
    }

    box.innerHTML = link
      ? `<button type="button" class="focus-suggest-row is-link" role="option" data-focus-link="${esc(q.trim())}">
           <span class="focus-suggest-title">Analyse this link</span>
           <span class="focus-suggest-meta">reads the post from the archive and adds it to your posts</span>
         </button>`
      : list.map((p) => `
          <button type="button" class="focus-suggest-row" role="option" data-focus-post="${esc(p.id)}">
            <span class="focus-suggest-title">${esc(trunc(p.title || "(untitled)", 90))}</span>
            <span class="focus-suggest-meta">r/${esc(p.subreddit)} · ${Util.fmtNum(p.score || 0)} pts${p.imported ? " · just added" : ""}</span>
          </button>`).join("");
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function closeSuggestions() {
    const box = document.getElementById("focus-suggest");
    const input = document.getElementById("focus-input");
    if (box) { box.hidden = true; box.innerHTML = ""; }
    if (input) input.setAttribute("aria-expanded", "false");
    suggestIndex = -1;
  }

  function moveSuggestion(delta) {
    const box = document.getElementById("focus-suggest");
    if (!box || box.hidden) return;
    const rows = Array.from(box.querySelectorAll(".focus-suggest-row"));
    if (!rows.length) return;
    suggestIndex = (suggestIndex + delta + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle("is-active", i === suggestIndex));
    rows[suggestIndex].scrollIntoView({ block: "nearest" });
  }

  function commitSuggestion() {
    const box = document.getElementById("focus-suggest");
    if (!box || box.hidden) return false;
    const rows = Array.from(box.querySelectorAll(".focus-suggest-row"));
    const row = rows[suggestIndex >= 0 ? suggestIndex : 0];
    if (!row) return false;
    row.click();
    return true;
  }

  /* A pasted link, resolved inline. The analyse dialog does more —
     crossposts, campaign creation — but making someone open a modal to
     answer the question the card is already asking is a detour. */
  async function adoptLink(text) {
    if (busy) return;
    busy = true;
    lastError = "";
    focusId = null;
    render();
    setStatus("Reading the post from the archive…");
    try {
      const result = await Analyze.run(text, {
        onStage: (name, detail) => { if (detail) setStatus(detail); },
      });
      App.rerenderAll();
      /* Analyze already matched it. Reusing that saves the whole
         discovery pass a second time. */
      if (result.related) {
        cache.set(result.post.id, {
          signature: dataSignature,
          result: await NextMove.rank(result.post, {
            timing: timing,
            related: result.related,
            exclude: Array.from(result.takenSubs || []),
          }),
        });
      }
      busy = false;
      View.set(result.post.id);
    } catch (err) {
      busy = false;
      lastError = (err && err.message) || String(err);
      render();
    }
  }

  function setStatus(text) {
    const el = document.getElementById("focus-status");
    if (el) el.textContent = text || "";
  }

  /* ------------------------------------------------------------------
   * RENDER
   * ------------------------------------------------------------------ */

  function render() {
    const h = host();
    if (!h) return;
    const post = focused();

    if (!post) {
      h.innerHTML = pickerHtml();
      if (lastError) {
        const s = document.getElementById("focus-status");
        if (s) { s.textContent = lastError; s.className = "focus-status is-err"; }
      }
      return;
    }

    const result = resultFor(post);
    h.innerHTML = `
      ${chosenHtml(post)}
      ${result ? answerHtml(result) : pendingHtml()}
    `;
  }

  function pickerHtml() {
    const n = (window.AppState && AppState.posts.length) || 0;
    return `
      <div class="focus-pick">
        <div class="focus-field">
          <input id="focus-input" class="focus-input" type="search" autocomplete="off"
                 role="combobox" aria-expanded="false" aria-controls="focus-suggest"
                 aria-label="Choose a post to place"
                 placeholder="${n ? "Search your posts, or paste a Reddit link" : "Paste a Reddit link"}" />
          <div id="focus-suggest" class="focus-suggest" role="listbox" hidden></div>
        </div>
        <p class="focus-status${lastError ? " is-err" : ""}" id="focus-status">${esc(lastError)}</p>
        ${n ? `<div class="focus-quick">${quickChips()}</div>` : ""}
      </div>
    `;
  }

  function quickChips() {
    return suggestions("").slice(0, 3).map((p) => `
      <button type="button" class="chip focus-quick-chip" data-focus-post="${esc(p.id)}"
              title="${esc(p.title)}">
        ${esc(trunc(p.title || "(untitled)", 42))}
        <span class="chip-meta">r/${esc(p.subreddit)}</span>
      </button>`).join("");
  }

  function chosenHtml(post) {
    const body = Util.postBody(post, 240);
    const read = ["title"];
    if (body) read.push("body");
    if (post.flair) read.push("flair");
    return `
      <div class="focus-chosen">
        <div class="focus-chosen-main">
          <div class="focus-chosen-title">${esc(trunc(post.title || "(untitled)", 120))}</div>
          <div class="focus-chosen-meta">r/${esc(post.subreddit)} · ${Util.fmtNum(post.score || 0)} pts · read from ${esc(read.join(" and "))}</div>
        </div>
        <button type="button" class="btn ghost small" data-action="focus-clear">Change</button>
      </div>
    `;
  }

  function pendingHtml() {
    if (lastError) {
      return `<p class="focus-status is-err">${esc(lastError)}</p>
              <p class="hint">The post is in your Posts list either way.</p>`;
    }
    return `<div class="focus-pending">${Dom.skeleton(3)}
            <p class="hint">Reading what this post is about, then checking every matching community's clock…</p></div>`;
  }

  function answerHtml(result) {
    if (!result.lead && !result.moves.length && !result.unmeasured.length) {
      return `<p class="focus-status">Nothing in the catalog or your loaded communities reads like this post.
              Try loading a sphere that covers its subject from Communities.</p>`;
    }

    const rest = result.moves.filter((m) => m !== result.lead);
    return `
      ${result.lead ? leadHtml(result.lead, result) : noneMeasuredHtml(result)}
      ${rest.length ? `
        <div class="focus-block">
          <div class="focus-block-label">Then</div>
          <ol class="focus-moves">${rest.map(moveHtml).join("")}</ol>
        </div>` : ""}
      ${result.unmeasured.length ? `
        <details class="focus-unmeasured"${result.moves.length ? "" : " open"}>
          <summary>${result.unmeasuredCount} ${result.moves.length
            ? "more read like this post but have nothing loaded"
            : `communit${result.unmeasuredCount === 1 ? "y reads" : "ies read"} like this post but ${result.unmeasuredCount === 1 ? "has" : "have"} nothing loaded`}</summary>
          <p class="hint">No posts from these means no clock for them. Load one and it gets a time like the rest.</p>
          <ul class="focus-unmeasured-list">
            ${result.unmeasured.map(unmeasuredHtml).join("")}
          </ul>
        </details>` : ""}
      ${footnoteHtml(result)}
    `;
  }

  /* Everything loaded was about something else. Not a failure — the
     honest answer is that the next move is to load one of the
     communities below, and saying so beats ranking irrelevant rooms. */
  function noneMeasuredHtml(result) {
    const n = result.rejected;
    return `
      <div class="focus-lead" data-verdict="none">
        <div class="focus-lead-label">Next move</div>
        <div class="focus-lead-headline"><strong>Load a community that fits</strong></div>
        <p class="focus-lead-why">Nothing you have loaded is about this subject${n
          ? `, so none of your ${n} measured communit${n === 1 ? "y" : "ies"} is a fair suggestion for it`
          : ""}. The ones below read like the post but have no posts loaded, so there is no clock for them yet — load one and it gets a time like any other.</p>
      </div>
    `;
  }

  function verdictBadge(move) {
    const v = NextMove.VERDICTS[move.verdict];
    if (!v) return "";
    const why = NextMove.heldLabel(move) || v.why;
    return `<span class="badge ${v.tone} focus-verdict" title="${esc(why)}">${esc(v.label)}</span>`;
  }

  function leadHtml(m, result) {
    const when = !m.graded
      ? `<strong>Post any time</strong>`
      : m.when && m.when.open
        ? `<strong>Post now</strong>`
        : `<strong>${esc((m.when && m.when.label) || m.slotLabel)}</strong>`;
    const tail = !m.graded
      ? "no hour there beats any other"
      : m.when
        ? (m.when.open ? `window open until ${esc(m.when.closesAt)}` : esc(m.when.inLabel))
        : "";

    return `
      <div class="focus-lead" data-verdict="${esc(m.verdict)}">
        <div class="focus-lead-label">Next move</div>
        <div class="focus-lead-headline">${when} in <span class="focus-lead-sub">r/${esc(m.name)}</span></div>
        <div class="focus-lead-sub-line">${tail}${verdictBadge(m)}</div>
        ${signalsHtml(m)}
        <p class="focus-lead-why">${esc(explain(m, result))}</p>
        <div class="focus-lead-actions">
          ${drillable(m) ? `<button type="button" class="btn small" data-timing-goto="${esc(m.key)}"
                  title="Open r/${esc(m.name)}'s own chart on the Timing tab">See the hours</button>` : ""}
          <button type="button" class="btn small" data-action="focus-campaign"
                  title="Track this post and everywhere else it is already posted as one campaign">Make a campaign</button>
        </div>
      </div>
    `;
  }

  /* The three signals, in the same order and the same shape everywhere,
     so a row can be read across rather than parsed. */
  function signalsHtml(m) {
    const gain = NextMove.gainLabel(m.ratio);
    const floor = m.graded && m.ratioLow && m.ratioLow > 1.02
      ? `at least ${m.ratioLow.toFixed(1).replace(/\.0$/, "")}×`
      : "";
    return `
      <div class="focus-signals">
        <span class="focus-sig" title="How much this post's words and subject look like this community, out of 100">
          <b>${m.fit}</b> match
        </span>
        <span class="focus-sig" title="${esc(gainTitle(m))}">
          <b>${esc(gain)}</b>${floor ? ` <span class="focus-sig-floor">${esc(floor)}</span>` : ""}
        </span>
        <span class="focus-sig" title="${esc(timingTitle(m))}">
          ${m.graded
            ? `<b>${esc(m.slotLabel)}</b> ${m.lift > 0 ? `+${Math.round(m.lift)}% there` : "its peak"}`
            : `<b>any time</b> no peak hour there`}
        </span>
      </div>
    `;
  }

  function gainTitle(m) {
    return m.graded
      ? `A typical post in r/${m.name} in its ${m.slotLabel} window, against a typical post where this one is now`
      : `A typical post in r/${m.name}, against a typical post where this one is now. No timing gain is counted, because this community's posts do not favour any particular hour.`;
  }

  function timingTitle(m) {
    if (!m.graded) {
      return `Across ${m.posts} posts, r/${m.name} does about as well whenever you post. `
        + "Naming an hour here would be reading noise.";
    }
    const parts = [`Posts in r/${m.name} around ${m.slotLabel} typically do ${Math.round(m.lift)}% better than that community's own average`];
    if (m.posts) parts.push(`read from ${m.posts} posts`);
    if (m.dowName) parts.push(`${m.dowName}s specifically`);
    return parts.join(" · ");
  }

  function moveHtml(m) {
    return `
      <li class="focus-move" data-verdict="${esc(m.verdict)}"${drillable(m) ? ` data-timing-goto="${esc(m.key)}" role="button" tabindex="0"` : ""}>
        <div class="focus-move-head">
          <span class="focus-move-sub">r/${esc(m.name)}</span>
          ${verdictBadge(m)}
          ${m.graded ? `<span class="focus-move-when">${esc(
            m.when ? (m.when.open ? "open now" : m.when.label) : m.slotLabel)}</span>` : ""}
        </div>
        ${signalsHtml(m)}
      </li>
    `;
  }

  function unmeasuredHtml(m) {
    return `
      <li class="focus-unmeasured-row">
        <span class="focus-move-sub">r/${esc(m.name)}</span>
        <span class="focus-sig"><b>${m.fit}</b> match</span>
        <span class="focus-unmeasured-meta">${esc(m.viaSphere ? `via ${m.viaSphere}` : (m.record && m.record.subscribers ? `${Util.fmtNum(m.record.subscribers)} members` : "in the catalog"))}</span>
        <button type="button" class="btn tiny" data-action="focus-load-sub" data-sub="${esc(m.name)}">${m.loaded ? "Sync" : "Load"}</button>
      </li>
    `;
  }

  function drillable(m) {
    return !!(m && m.measured && window.DashboardView && DashboardView.canRevealTiming
      && DashboardView.canRevealTiming(m.key));
  }

  /* One sentence naming which of the two halves is doing the work, so
     the multiple is never just asserted. */
  function explain(m, result) {
    const bits = [];
    const reach = m.reachRatio || 0;
    const timingGain = m.graded ? Math.round(m.lift || 0) : 0;

    if (reach >= 1.15 && timingGain >= 10) {
      bits.push(`r/${m.name} typically outperforms ${result.baseline.label} by ${fmtX(reach)}, and its ${m.slotLabel} window adds another ${timingGain}%`);
    } else if (reach >= 1.15) {
      bits.push(`r/${m.name} typically outperforms ${result.baseline.label} by ${fmtX(reach)}`
        + (m.measured && !m.graded ? ", whenever you post" : ""));
    } else if (reach <= 0.85) {
      /* Saying this plainly matters more than the suggestion does. It
         is the closest match for the subject and still a step down in
         reach, and a card that buried that would be selling a move it
         has evidence against. */
      bits.push(`r/${m.name} is the closest match for the subject, but a typical post there gets ${Math.round((1 - reach) * 100)}% less than ${result.baseline.label}`
        + (timingGain >= 10 ? `, even at its ${m.slotLabel} peak` : ""));
    } else if (timingGain >= 10) {
      bits.push(`r/${m.name} is about as big a stage as where you are, but its ${m.slotLabel} window is worth ${timingGain}%`);
    } else {
      bits.push(`r/${m.name} reads like this post, and the numbers there are much the same as ${result.baseline.label}`);
    }

    if (m.overlapTerms && m.overlapTerms.length) {
      bits.push(`shared wording: ${m.overlapTerms.slice(0, 3).join(", ")}`);
    } else if (m.viaSphere) {
      bits.push(`matched through ${m.viaSphere}`);
    }
    return bits.join(" · ") + ".";
  }

  function fmtX(r) {
    return r >= 1.95 ? `${r.toFixed(1).replace(/\.0$/, "")}×` : `${Math.round((r - 1) * 100)}%`;
  }

  function footnoteHtml(result) {
    const b = result.baseline;
    if (!b || !b.score) return "";
    return `<p class="focus-foot">Compared against ${esc(b.label)} (${Util.fmtNum(Math.round(b.score))} pts).
            These are what a typical post does, not a forecast for this one.</p>`;
  }

  /* ------------------------------------------------------------------
   * WIRING
   * ------------------------------------------------------------------ */

  /* Called by the dashboard whenever it repaints the Summary tab. */
  View.paint = function (timingModel, signature) {
    timing = timingModel || null;
    if (signature !== dataSignature) {
      dataSignature = signature || "";
      /* Timing moved under it, so any cached ranking is stale. */
      cache.clear();
    }
    render();
    if (focusId && focused() && !resultFor(focused())) rank();
  };

  /* Send a post here from anywhere — the posts table, the detail panel,
     the analyse dialog. */
  View.focusPost = function (post) {
    if (!post) return;
    if (window.Analyze && Analyze.adopt) Analyze.adopt(post);
    View.set(post.id);
    Router.go("dashboard");
    if (window.DashboardView) DashboardView.goToSection("summary");
    const card = document.getElementById("focus-card");
    if (card) card.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  View.mount = function () {
    try { focusId = localStorage.getItem(KEY) || null; } catch (_) {}

    Dom.delegate(document, "input", "#focus-input", renderSuggestions);
    Dom.delegate(document, "focus", "#focus-input", renderSuggestions, true);

    Dom.delegate(document, "keydown", "#focus-input", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); moveSuggestion(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveSuggestion(-1); }
      else if (e.key === "Enter") { if (commitSuggestion()) e.preventDefault(); }
      else if (e.key === "Escape") { closeSuggestions(); }
    });

    Dom.delegate(document, "click", "[data-focus-post]", (e, btn) => {
      e.preventDefault();
      closeSuggestions();
      View.set(btn.dataset.focusPost);
    });

    Dom.delegate(document, "click", "[data-focus-link]", (e, btn) => {
      e.preventDefault();
      closeSuggestions();
      adoptLink(btn.dataset.focusLink);
    });

    Dom.delegate(document, "click", '[data-action="focus-clear"]', () => View.set(null));

    Dom.delegate(document, "click", '[data-action="focus-campaign"]', () => {
      const post = focused();
      if (!post) return;
      try {
        const made = Analyze.campaignFrom({ post: post, elsewhere: Analyze.findLocally(post) });
        Util.toast(`Created "${made.campaign.name}" with ${made.posts.length} post${made.posts.length === 1 ? "" : "s"}.`, "ok");
        App.populateCampaignSelectors();
        App.openCampaign(made.campaign);
      } catch (err) {
        Util.toast("Couldn't create the campaign: " + ((err && err.message) || err), "err");
      }
    });

    Dom.delegate(document, "click", '[data-action="focus-load-sub"]', (e, btn) => {
      const name = btn.dataset.sub;
      if (!name || btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "Loading…";
      AppState.addSubs([name]);
      App.renderChips();
      Refresh.subs([name]).finally(() => {
        /* Its posts are the whole point — the ranking has a clock for
           this community now, so every cached answer is out of date. */
        cache.clear();
        App.rerenderAll();
      });
    });

    /* A click anywhere else puts the typeahead away. */
    document.addEventListener("click", (e) => {
      if (e.target.closest && e.target.closest(".focus-field")) return;
      closeSuggestions();
    });
  };

  window.FocusView = View;
})();
