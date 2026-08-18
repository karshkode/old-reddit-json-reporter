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
  /* Syndicated headlines live here, not in AppState.posts — adopting
   * them into the inventory is what put fake rows in the Posts table. */
  let focusDraft = null;
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
    if (!id) return null;
    if (focusDraft && focusDraft.id === id) return focusDraft;
    if (!window.AppState) return null;
    return AppState.posts.find((p) => p && p.id === id) || null;
  }

  function focused() { return findPost(focusId); }

  View.set = function (id) {
    focusId = id || null;
    if (!focusId || !(focusDraft && focusDraft.id === focusId)) focusDraft = null;
    lastError = "";
    try {
      if (focusId && !(focusDraft && focusDraft.syndicated)) localStorage.setItem(KEY, focusId);
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
      const campaign = focusedCampaign(post);
      const tune = campaignTune(campaign);
      const work = Object.assign({}, post);
      if (tune.extra) {
        work.selftext = [post.selftext || "", tune.extra].filter(Boolean).join("\n");
      }
      const result = await NextMove.rank(work, {
        timing: timing,
        exclude: alreadyIn(post),
        live: tune.loadedOnly ? false : !(window.Demo && Demo.isActive()),
        loadedOnly: tune.loadedOnly,
        minFit: tune.minFit || undefined,
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

  /* On-device OCR for screenshot / image posts. Fills post.image_text so
   * Discovery can match on what the image actually says, then re-ranks. */
  async function runImageText(post, opts) {
    opts = opts || {};
    if (!post || !window.ImageText || !ImageText.ensure) return null;
    if (!ImageText.isImagePost(post)) return null;
    if (post.image_text && !opts.force) return post.image_text;

    const btn = document.querySelector('#focus-card [data-action="focus-ocr"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = opts.interactive ? "Reading…" : "Trying…";
    }
    try {
      if (typeof setStatus === "function") setStatus("Reading text in the image (on-device OCR)…");
    } catch (_) {}
    try {
      const text = await ImageText.ensure(post, {
        force: !!opts.force,
        interactive: !!opts.interactive,
        allowLocalFallback: !!opts.interactive,
        onStatus: (msg) => {
          try { setStatus(msg); } catch (_) {}
          if (btn && msg) {
            btn.textContent = /pick|blocked|paste|save|Choose/i.test(msg) ? "Choose image…" : "Reading…";
          }
        },
      });
      cache.delete(post.id);
      if (window.AppState && AppState.postRelated) AppState.postRelated.delete(post.id);
      if (opts.interactive) {
        const via = post.image_text_source === "upload" || post.image_text_source === "paste"
          ? " from your image"
          : "";
        try { Util.toast("Image text ready" + via + " — re-ranking destinations.", "ok"); } catch (_) {}
      }
      if (focusId === post.id) {
        busy = false;
        await rank();
      } else {
        render();
      }
      return text;
    } catch (err) {
      if (opts.interactive) {
        const msg = (err && err.message) || String(err);
        try {
          Util.toast(/cancel/i.test(msg) ? "Image read cancelled." : ("Couldn't read image: " + msg), "err");
        } catch (_) {}
      }
      render();
      return null;
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

  function setPostedStatus(text, isError) {
    const el = document.getElementById("focus-posted-hint");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-err", !!isError);
  }

  /* The user pasted what they just posted. Fetch it, put it in the
     inventory, and tie it to this post explicitly — the copy detector
     works on title fingerprints and shared links, and rewording the
     headline for a new community defeats both. Their word beats the
     fingerprint. */
  async function trackPasted(post, text) {
    const raw = String(text || "").trim();
    if (!raw || busy) return;
    if (!Analyze.looksLikePost(raw)) {
      setPostedStatus("That does not look like a link to a Reddit post — paste the /comments/… URL from the address bar.", true);
      return;
    }

    busy = true;
    setPostedStatus("Reading it from the archive…");
    try {
      const res = await Analyze.run(raw, {
        onStage: (name, detail) => { if (detail) setPostedStatus(detail); },
      });
      Crosspost.link(post.id, res.post.id);
      Crosspost.clearOpened(post.id, res.post.subreddit);
      Crosspost.reconcile(post);
      const synced = Crosspost.syncCampaign(post);
      busy = false;
      Util.toast(synced
        ? `Added r/${res.post.subreddit} to "${synced.campaign.name}".`
        : `Now tracking your copy in r/${res.post.subreddit}.`, "ok");
      /* It is a new post in a possibly-new community, so everything
         downstream of the inventory moved, the ranking included: the
         community it landed in is no longer somewhere to suggest. */
      App.rerenderAll();
      render();
    } catch (err) {
      busy = false;
      setPostedStatus((err && err.message) || String(err), true);
    }
  }

  /* A copy that turned up in an ordinary sync belongs in whatever is
     already tracking this story, without anyone filing it. Idempotent,
     so calling it on every paint costs one set comparison and fires
     exactly once per copy found. */
  function autoTrack(post) {
    let synced = null;
    try { synced = Crosspost.syncCampaign(post); } catch (_) { return; }
    if (!synced) return;
    const where = synced.added.map((p) => `r/${p.subreddit}`).join(", ");
    /* Out of the render pass before touching campaign state, which
       invalidates routes and repaints the rail. */
    setTimeout(() => {
      Util.toast(`Added ${where} to "${synced.campaign.name}".`, "ok");
      App.publishCampaign(synced.campaign);
    }, 0);
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

    autoTrack(post);

    const result = resultFor(post);
    h.innerHTML = `
      ${chosenHtml(post)}
      ${result ? answerHtml(result) : pendingHtml()}
    `;
    if (window.SyndicateView && SyndicateView.paintPlanCarousel) {
      SyndicateView.paintPlanCarousel();
    }
  }

  /* ------------------------------------------------------------------
   * THE RUN
   * ------------------------------------------------------------------ */

  /* The order to do it in, built from the communities directly above it.
   *
   * The cascade used to live in a campaign's Plan tab and take its
   * communities from a dropdown of "active subs" or a whole campaign,
   * which meant the schedule and the recommendations were two answers to
   * the same question, computed from different inputs, disagreeing in
   * public. You would be told r/antiwork was the best next move and then
   * handed a plan that never mentioned it. Same list now: whatever
   * ranked above is what gets scheduled. */
  function runHtml(result) {
    /* Folded into the Next move / Then list — cascade times attach to
     * each row so Plan answers once instead of twice. */
    return "";
  }

  function runSubs(result) {
    return (result.moves || []).filter((m) => m.measured).map((m) => m.name);
  }

  function attachSchedule(result) {
    const moves = (result.moves || []).slice();
    if (moves.length < 2 || !window.Analysis || !Analysis.cascadeSchedule) {
      return moves.map((m) => Object.assign({}, m, { runAt: null }));
    }
    let schedule;
    try {
      schedule = Analysis.cascadeSchedule(runSubs(result), {
        posts: (window.AppState && AppState.posts) || [],
        subProfiles: (window.AppState && AppState.subProfiles) || {},
        limit: 0,
      });
    } catch (err) {
      console.warn("[focus] cascade:", err && err.message);
      return moves.map((m) => Object.assign({}, m, { runAt: null }));
    }
    const stops = Array.isArray(schedule) ? schedule : ((schedule && schedule.stops) || []);
    const byName = new Map();
    for (const stop of stops) {
      if (!stop || !stop.sub) continue;
      const when = stop.openNow
        ? `now · ${fmtRunTime(stop.targetTime)}`
        : fmtRunTime(stop.targetTime);
      byName.set(String(stop.sub).toLowerCase(), Object.assign({}, stop, { label: when }));
    }
    return moves.map((m) => Object.assign({}, m, {
      runAt: byName.get(String(m.name).toLowerCase()) || null,
    }));
  }

  function fmtRunTime(d) {
    if (!d) return "";
    try {
      return new Date(d).toLocaleString(undefined, {
        weekday: "short", hour: "numeric", minute: "2-digit",
      });
    } catch (_) {
      return "";
    }
  }

  function paintRun() {
    /* no-op — schedule lives on move rows now */
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
    let scrubbedOcr = false;
    if (window.ImageText && ImageText.getCached && !post.image_text) {
      const hit = ImageText.getCached(post.id);
      if (hit && hit.text) {
        if (ImageText.isPlausible && !ImageText.isPlausible(hit.text)) {
          ImageText.clear(post);
          scrubbedOcr = true;
        } else {
          ImageText.applyToPost(post, hit.text, hit.source);
        }
      }
    }
    if (post.image_text && window.ImageText && ImageText.isPlausible
        && !ImageText.isPlausible(post.image_text)) {
      ImageText.clear(post);
      scrubbedOcr = true;
    }
    if (scrubbedOcr) {
      cache.delete(post.id);
      if (window.AppState && AppState.postRelated) AppState.postRelated.delete(post.id);
      /* Rematch without the junk OCR so destinations aren't poisoned. */
      window.setTimeout(() => {
        if (focusId === post.id && !busy) rank().catch(() => {});
      }, 0);
    }
    const body = Util.postBody(post, 240);
    const read = ["title"];
    if (post.selftext && String(post.selftext).trim()
        && post.selftext !== "[removed]" && post.selftext !== "[deleted]") {
      read.push("body");
    }
    if (post.image_text) read.push("image text");
    else if (post.media_captions) read.push("image caption");
    if (post.flair) read.push("flair");
    const kind = window.Rules ? Rules.classify(post) : null;
    const kindBit = kind
      ? `<span class="focus-kind" title="What kind of post this is — used to skip communities whose rules reject it">${esc(kind.label)}</span>`
      : "";
    /* Syndicated articles have no Reddit home — show the outlet, never
     * a blank "r/". A match suggestion is labelled as such and must not
     * look like an existing submission. */
    let whereBit;
    if (post.syndicated) {
      const tip = post.suggested_sub || post.subreddit;
      whereBit = `<span class="focus-source">${esc(post.source_label || post.author || "Syndicated")}</span>`
        + (tip ? ` · suggested r/${esc(tip)}` : "");
    } else {
      whereBit = `r/${esc(post.subreddit || "?")}`;
    }
    const scoreBit = post.syndicated
      ? ""
      : ` · ${Util.fmtNum(post.score || 0)} pts`;
    const cmtBit = (!post.syndicated && post.num_comments)
      ? ` · ${Util.fmtNum(post.num_comments)} comments`
      : "";
    const feedBtn = (!post.syndicated && window.FeedView)
      ? `<button type="button" class="btn ghost small" data-action="focus-open-feed"
                 title="Read this post in the in-app feed">View</button>`
      : "";
    const needsOcr = window.ImageText && ImageText.isImagePost(post)
      && Util.postIsTextThin(post)
      && !post.image_text;
    const ocrBtn = needsOcr
      ? `<button type="button" class="btn small" data-action="focus-ocr"
                 title="Read text in the image. If Reddit blocks the download (403), you will be asked to pick a saved copy or screenshot — OCR still runs on this device.">Read image text</button>`
      : (post.image_text
        ? `<button type="button" class="btn ghost small" data-action="focus-ocr" data-force="1"
                   title="Re-run OCR on the image">Re-read image</button>
           <button type="button" class="btn ghost small" data-action="focus-ocr-clear"
                   title="Drop image text so matching uses title/flair only">Discard image text</button>`
        : "");
    const imagePreview = post.image_text
      ? `<p class="focus-image-text" title="Text read from the image (${esc(post.image_text_source || "ocr")})">${esc(trunc(post.image_text, 280))}</p>`
      : "";
    return `
      <div class="focus-chosen">
        <div class="focus-chosen-main">
          ${campaignThemeChip(post)}
          <div class="focus-chosen-title">${esc(trunc(post.title || "(untitled)", 120))}</div>
          <div class="focus-chosen-meta">${whereBit}${scoreBit}${cmtBit} · ${kindBit}${kindBit ? " · " : ""}read from ${esc(read.join(" and "))}</div>
          ${audienceStrip(post)}
          ${imagePreview}
        </div>
        <div class="focus-chosen-actions">
          ${ocrBtn}
          ${feedBtn}
          <button type="button" class="btn ghost small" data-action="focus-clear">Change</button>
        </div>
      </div>
      ${composerHtml(post)}
      ${campaignTuneHtml(post)}
      ${campaignRosterHtml(post)}
      ${reachHtml(post)}
      ${pendingPostHtml(post)}
    `;
  }

  /* ------------------------------------------------------------------
   * CAMPAIGN COMPOSER
   * ------------------------------------------------------------------
   * A campaign in Plan ranks on its whole profile, but a submit page
   * takes one headline and one piece of content. This strip is where
   * the user picks both: type or choose the headline, and choose which
   * material travels — a member post's link or text, the theme article,
   * or a fresh text post. Every Cross-post link on the card follows the
   * choice, live, without re-ranking. */

  function focusedCampaign(post) {
    if (!post || !window.Campaigns) return null;
    if (post.campaignId) return Campaigns.get(post.campaignId);
    if (window.AppState && AppState.openCampaignId) {
      const open = Campaigns.get(AppState.openCampaignId);
      if (open && (open.postIds || []).indexOf(post.id) >= 0) return open;
    }
    return null;
  }

  /* Compact chip so the theme supports the card instead of becoming
   * the headline. The working title is the post (or compose draft). */
  function campaignThemeChip(post) {
    const campaign = focusedCampaign(post);
    if (!campaign || !campaign.theme) return "";
    const kind = Campaigns.themeKindLabel(campaign.theme) || "Theme";
    const label = campaign.theme.label || campaign.name;
    return `<div class="focus-theme-chip">
      <span class="badge info">${esc(kind)}</span>
      <span class="focus-theme-chip-label">${esc(trunc(label, 72))}</span>
    </div>`;
  }

  function campaignTune(campaign) {
    const t = (campaign && campaign.tune) || {};
    return {
      extra: String(t.extra || "").trim(),
      loadedOnly: !!t.loadedOnly,
      minFit: Number.isFinite(Number(t.minFit)) ? Math.max(0, Math.min(80, Number(t.minFit))) : 0,
    };
  }

  /* Extra keywords, loaded-only, min-match — persist on the campaign
   * and feed the next rank without leaving Plan. */
  function campaignTuneHtml(post) {
    const campaign = focusedCampaign(post);
    if (!campaign) return "";
    const tune = campaignTune(campaign);
    return `
      <details class="focus-tune" data-focus-tune>
        <summary>Tune this ranking</summary>
        <p class="meta">These inputs reshape the destinations below — they do not change the I can post slider, which still clips every clock.</p>
        <div class="focus-tune-grid">
          <label class="focus-compose-field">
            <span class="group-label">Boost keywords</span>
            <input id="focus-tune-extra" type="text" autocomplete="off"
                   value="${esc(tune.extra)}" placeholder="mail-in voting, section 338…" />
          </label>
          <label class="focus-compose-field">
            <span class="group-label">Min match</span>
            <input id="focus-tune-minfit" type="number" min="0" max="80" step="5"
                   value="${tune.minFit || ""}" placeholder="default" />
          </label>
          <label class="focus-tune-check">
            <input id="focus-tune-loaded" type="checkbox"${tune.loadedOnly ? " checked" : ""} />
            <span>Loaded rooms only — skip catalog / keyword search</span>
          </label>
        </div>
      </details>`;
  }

  /* One row per campaign post/article so the next move is for a
   * concrete piece of material, not the campaign-as-blob. */
  function campaignRosterHtml(post) {
    const campaign = focusedCampaign(post);
    if (!campaign || !window.Campaigns || !Campaigns.resolvePosts) return "";
    const members = Campaigns.resolvePosts(campaign);
    const theme = campaign.theme || null;
    const rows = [];
    if (theme && (theme.articleLink || theme.articleId)) {
      rows.push({
        id: theme.articleId ? "art_" + theme.articleId : "art_theme",
        kind: "article",
        title: theme.label || campaign.name,
        meta: "Theme article",
        isCurrent: !!(post.syndicated && post.campaignId && !members.some((p) => p && p.id === post.id)),
      });
    }
    for (const p of members.slice(0, 12)) {
      if (!p || !p.id) continue;
      rows.push({
        id: p.id,
        kind: "post",
        title: p.title || "(untitled)",
        meta: `r/${p.subreddit || "?"} · ${Util.fmtNum(p.score || 0)} pts`,
        isCurrent: post.id === p.id,
        post: p,
      });
    }
    if (!rows.length) return "";
    return `
      <div class="focus-roster">
        <div class="focus-compose-head">
          <span class="focus-block-label">Next move for each piece</span>
          <span class="meta">Rank a row to time that post or article on its own</span>
        </div>
        <ul class="focus-roster-list">
          ${rows.map((r) => {
            const cached = r.post ? resultFor(r.post) : null;
            const lead = cached && cached.lead;
            const nextBit = lead
              ? ` → r/${esc(lead.name)}${lead.when && lead.when.label ? ` · ${esc(lead.when.label)}` : (!lead.graded ? " · any time" : "")}`
              : "";
            return `<li class="focus-roster-row${r.isCurrent ? " is-current" : ""}">
              <div class="focus-roster-main">
                <span class="focus-roster-title">${esc(trunc(r.title, 80))}</span>
                <span class="meta">${esc(r.meta)}${nextBit}</span>
              </div>
              ${r.isCurrent
                ? `<span class="badge info">ranking</span>`
                : `<button type="button" class="btn tiny" data-action="focus-roster-rank" data-post-id="${esc(r.id)}"
                           data-kind="${esc(r.kind)}">Rank this</button>`}
            </li>`;
          }).join("")}
        </ul>
      </div>`;
  }

  /* What buildSubmitUrl should receive for this post — the compose
   * draft for a campaign pseudo-post, the post itself otherwise. */
  function submitDataFor(post) {
    const campaign = focusedCampaign(post);
    if (!campaign || !Campaigns.composeDraft) return post;
    return Campaigns.composeDraft(campaign) || post;
  }

  function composePreview(draft) {
    if (!draft) return "";
    if (draft.isLinkPost && draft.url) {
      let domain = draft.url;
      try { domain = new URL(draft.url).hostname.replace(/^www\./, ""); } catch (_) {}
      return `Link post → ${esc(domain)}`;
    }
    const words = String(draft.body || "").trim();
    return words
      ? `Text post → ${esc(trunc(words, 90))}`
      : "Text post → empty body, write it on Reddit";
  }

  function composerHtml(post) {
    const campaign = focusedCampaign(post);
    if (!campaign || !window.Campaigns || !Campaigns.composeDraft) return "";
    const draft = Campaigns.composeDraft(campaign);
    const headlines = Campaigns.headlineOptions(campaign);
    const sources = Campaigns.composeOptions(campaign);
    return `
      <div class="focus-compose" data-focus-compose>
        <div class="focus-compose-head">
          <span class="focus-block-label">What gets submitted</span>
          <span class="meta">every Cross-post link below carries this headline and content</span>
        </div>
        <div class="focus-compose-grid">
          <label class="focus-compose-field">
            <span class="group-label">Headline</span>
            <input id="focus-compose-title" type="text" maxlength="300" autocomplete="off"
                   value="${esc(draft.title)}" placeholder="Headline for the submit page" />
          </label>
          ${headlines.length > 1 ? `
          <label class="focus-compose-field">
            <span class="group-label">Use headline from</span>
            <select id="focus-compose-headline-pick" aria-label="Insert a headline from the campaign">
              <option value="">Pick one to insert…</option>
              ${headlines.map((h) => `
                <option value="${esc(h.text)}">${esc(trunc(h.text, 70))} — ${esc(h.from)}</option>`).join("")}
            </select>
          </label>` : ""}
          <label class="focus-compose-field">
            <span class="group-label">Content</span>
            <select id="focus-compose-source" aria-label="Which material to post">
              ${sources.map((o) => `
                <option value="${esc(o.id)}"${o.id === draft.sourceId ? " selected" : ""}>${esc(trunc(o.label, 60))}${o.title ? ` — ${esc(trunc(o.title, 50))}` : ""}</option>`).join("")}
            </select>
          </label>
        </div>
        <p class="focus-compose-preview meta" id="focus-compose-preview">${composePreview(draft)}</p>
      </div>`;
  }

  function saveCompose(patch) {
    const post = focused();
    const campaign = focusedCampaign(post);
    if (!campaign) return;
    const compose = Object.assign({}, campaign.compose || {}, patch);
    Campaigns.update(campaign.id, { compose: compose });
  }

  /* Rewrite every submit link in place — no re-render, so the headline
   * input keeps focus while the user types. */
  function updateSubmitLinks() {
    const post = focused();
    if (!post) return;
    const data = submitDataFor(post);
    const h = host();
    if (!h) return;
    for (const a of h.querySelectorAll('[data-action="focus-crosspost"]')) {
      const sub = a.dataset.sub;
      if (!sub) continue;
      const url = Crosspost.submitUrl(sub, data);
      if (url) a.href = url;
    }
    const preview = document.getElementById("focus-compose-preview");
    if (preview && data && Object.prototype.hasOwnProperty.call(data, "isLinkPost")) {
      preview.innerHTML = composePreview(data);
    }
  }

  function audienceStrip(post) {
    if (!post || post.syndicated) return "";
    const aud = window.AppState && AppState.audienceByPost
      ? AppState.audienceByPost.get(post.id)
      : null;
    const n = post.num_comments || 0;
    if (!aud || !aud.total) {
      if (n > 0) {
        return `<div class="focus-audience is-pending" data-focus-aud>
          <span class="meta">Audience · ${Util.fmtNum(n)} comments — reading tone…</span>
        </div>`;
      }
      return "";
    }
    const cls = aud.label === "supportive" ? "good"
      : aud.label === "hostile" ? "bad"
      : aud.label === "mixed" ? "warn" : "info";
    const keys = (aud.keywords || []).slice(0, 5).map((k) =>
      typeof k === "string" ? k : (k.word || "")
    ).filter(Boolean);
    return `<div class="focus-audience" data-focus-aud title="Comment-thread tone in r/${esc(post.subreddit || "?")} — separate from destination match">
      <span class="badge ${cls}">${esc(aud.label)}</span>
      <span class="meta">audience · ${Util.fmtNum(aud.total)} comments
        · ${Util.fmtNum(aud.support || 0)} support / ${Util.fmtNum(aud.oppose || 0)} oppose</span>
      ${keys.length ? `<span class="plan-rec-aud-keys">${keys.map((k) => `<code>${esc(k)}</code>`).join(" ")}</span>` : ""}
    </div>`;
  }

  async function ensureAudience(post) {
    if (!post || !post.id || post.syndicated) return null;
    if (!window.AppState || !window.Analysis || !Analysis.summarizeAudience) return null;
    if (!(post.num_comments > 0)) return null;
    if (AppState.audienceByPost.has(post.id)) return AppState.audienceByPost.get(post.id);
    try {
      let data = AppState.detailCache && AppState.detailCache.get(post.id);
      if (!data && window.Reddit && Reddit.fetchPostWithComments) {
        data = await Reddit.fetchPostWithComments(post.id, { commentLimit: 40 });
        if (data && AppState.detailCache) AppState.detailCache.set(post.id, data);
      }
      if (!data || !data.comments) return null;
      const summary = Analysis.summarizeAudience(data.comments);
      AppState.audienceByPost.set(post.id, summary);
      if (focusId === post.id) render();
      return summary;
    } catch (_) {
      return null;
    }
  }

  /* Where the content already is, and whether anything is tracking it.
     A campaign is only offered once there is a second copy: before that
     it would be a folder with one thing in it, and the button would be
     asking for filing when the user came here to post. */
  function reachHtml(post) {
    const copies = Crosspost.copiesOf(post);
    const campaign = Crosspost.campaignFor(post);

    /* By community, not by post. The same story can be submitted twice
       in one place, and a list reading "r/WorkReform r/antiwork
       r/WorkReform" is answering a question nobody asked. Each name
       links to the best-scoring copy there. */
    const all = [post].concat(copies);
    const byS = new Map();
    for (const p of all) {
      /* A syndicated draft is not a place the story has reached — even
       * when an older build stuffed a suggested sub into `subreddit`. */
      if (!p || p.syndicated) continue;
      const key = String(p.subreddit || "").toLowerCase();
      if (!key) continue;
      const prev = byS.get(key);
      if (!prev || (p.score || 0) > (prev.best.score || 0)) {
        byS.set(key, { best: p, n: (prev ? prev.n : 0) + 1 });
      } else {
        prev.n++;
      }
    }

    /* Copies in the community it is already in are not cross-posts, and
       a campaign over them has nothing to compare — the whole point of
       the totals is that they span communities. Three submissions in
       one subreddit is still one place this content has reached. */
    if (byS.size < 2) {
      if (post.syndicated && !byS.size) {
        return `
          <p class="focus-reach is-single">
            Not on Reddit yet — a syndicated headline. Match communities below, submit the link,
            then sync to start totalling copies.
          </p>`;
      }
      const again = copies.length
        ? ` (${copies.length + 1} submissions there)`
        : "";
      const home = post.subreddit
        ? `<b>r/${esc(post.subreddit)}</b>`
        : `<b>${esc(post.source_label || "one place")}</b>`;
      return `
        <p class="focus-reach is-single">
          Only in ${home} so far${again}. Cross-post it below and it gets
          totalled as a set once the copy turns up — nothing to track until then.
        </p>`;
    }

    const where = Array.from(byS.values())
      .sort((a, b) => (b.best.score || 0) - (a.best.score || 0))
      .map(({ best, n }) => {
        const label = `r/${esc(best.subreddit)}${n > 1 ? ` <span class="focus-reach-n">×${n}</span>` : ""}`;
        const tip = `${Util.fmtNum(best.score || 0)} pts${n > 1 ? ` · ${n} submissions there` : ""}`;
        return best.permalink
          ? `<a class="focus-reach-sub" href="${esc(best.permalink)}" target="_blank" rel="noopener"
                title="${esc(tip)}">${label}</a>`
          : `<span class="focus-reach-sub" title="${esc(tip)}">${label}</span>`;
      }).join(" ");

    const total = all.reduce((n, p) => n + (p.score || 0), 0);
    const subs = byS.size;
    const posts = all.length;

    return `
      <div class="focus-reach">
        <div class="focus-reach-main">
          <span class="focus-reach-label">Already in ${subs} communit${subs === 1 ? "y" : "ies"}</span>
          <span class="focus-reach-subs">${where}</span>
          <span class="focus-reach-total">${Util.fmtNum(total)} pts between them</span>
        </div>
        ${campaign
          ? `<button type="button" class="btn small" data-action="focus-open-campaign" data-campaign="${esc(campaign.id)}"
                     title="Open the campaign totalling these ${posts} posts">Tracking · ${esc(trunc(campaign.name, 24))}</button>`
          : `<button type="button" class="btn small" data-action="focus-track"
                     title="Total these ${posts} posts as one campaign. Only what is actually posted goes in — a recommendation is not a target until you have posted in it.">Track ${posts === subs ? `these ${posts}` : `all ${posts} posts`}</button>`}
      </div>`;
  }

  /* Cross-posting leaves the page, and whether a post followed happens
     on Reddit. So the intent is remembered and asked about once, with
     the honest alternative alongside: leave it, and the next sync of
     that community finds it anyway. */
  function pendingPostHtml(post) {
    const subs = Crosspost.pendingFor(post);
    if (!subs.length) return "";
    const names = subs.map((s) => `r/${esc(s)}`).join(", ");
    return `
      <div class="focus-posted">
        <form class="focus-posted-form" data-focus-posted>
          <label class="focus-posted-label" for="focus-posted-url">Posted it to ${names}?</label>
          <div class="focus-posted-row">
            <input id="focus-posted-url" class="focus-posted-input" type="url" name="url" autocomplete="off"
                   placeholder="Paste the link to your new post" />
            <button class="btn small primary" type="submit">Track it</button>
            <button class="btn ghost small" type="button" data-action="focus-posted-dismiss"
                    title="Stop asking. The next sync of that community will pick it up anyway.">Not yet</button>
          </div>
        </form>
        <p class="focus-posted-hint" id="focus-posted-hint">Or skip it — syncing ${names} will find the copy and add it here.</p>
      </div>`;
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
      if (result.blocked && result.blocked.length) {
        return `
          <p class="focus-status">Every community that reads like this post would reject it — ${esc((result.kind && result.kind.label) || "this format")} against their rules.</p>
          ${blockedHtml(result)}
          ${footnoteHtml(result)}`;
      }
      return `<p class="focus-status">Nothing strong matched yet from the catalog, your loaded communities, or a keyword search against the current desk.
              Try loading a sphere from Communities, or check Trends for today’s topic keywords.</p>`;
    }

    const lead = result.lead || null;
    const rest = (result.moves || []).slice()
      .filter((m) => !lead || m.key !== lead.key)
      .sort((a, b) => {
        const wa = NextMove.waitOf ? NextMove.waitOf(a) : 0;
        const wb = NextMove.waitOf ? NextMove.waitOf(b) : 0;
        if (wa !== wb) return wa - wb;
        return (b.score || 0) - (a.score || 0);
      });
    return `
      ${lead ? leadHtml(lead, result) : noneMeasuredHtml(result)}
      ${rest.length ? `
        <div class="focus-block">
          <div class="focus-block-label">Then · each room’s best window inside your hours</div>
          <ol class="focus-moves">${rest.map((m) => moveHtml(m, result.post)).join("")}</ol>
        </div>` : ""}
      ${result.unmeasured.length ? `
        <details class="focus-unmeasured"${result.moves.length ? "" : " open"}>
          <summary>${result.unmeasuredCount} ${result.moves.length
            ? "more read like this post but have nothing loaded"
            : `communit${result.unmeasuredCount === 1 ? "y reads" : "ies read"} like this post but ${result.unmeasuredCount === 1 ? "has" : "have"} nothing loaded`}</summary>
          <p class="hint">No posts from these means no clock for them. Load one and it gets a time like the rest.</p>
          <ul class="focus-unmeasured-list">
            ${result.unmeasured.map((m) => unmeasuredHtml(m, result.post)).join("")}
          </ul>
        </details>` : ""}
      ${blockedHtml(result)}
      ${footnoteHtml(result)}
    `;
  }

  /* Communities that match on subject but reject this post's format.
     Listed so the user knows why a "perfect" room is missing — silence
     looked like the matcher failed. */
  function blockedHtml(result) {
    const list = result.blocked || [];
    if (!list.length) return "";
    const kind = (result.kind && result.kind.label) || "this format";
    return `
      <details class="focus-blocked">
        <summary>${result.blockedCount} would reject ${esc(kind)}</summary>
        <p class="hint">Matched on subject, blocked by posting rules. Reformat the post or pick a different room.</p>
        <ul class="focus-blocked-list">
          ${list.map((m) => `
            <li class="focus-blocked-row">
              <span class="focus-move-sub">r/${esc(m.name)}</span>
              <span class="badge bad">${esc((m.ruleReasons && m.ruleReasons[0]) || "against the rules")}</span>
              ${m.rules && m.rules.rule && m.rules.rule.note
                ? `<span class="focus-blocked-note">${esc(m.rules.rule.note)}</span>` : ""}
            </li>`).join("")}
        </ul>
      </details>`;
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
      ? "no hour there beats any other — good anytime room"
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
          ${crosspostHtml(m, result.post, { lead: true })}
          ${planBtnHtml(m, result.post)}
        </div>
        ${detailHtml(m)}
      </div>
    `;
  }

  /* The action the whole card is for. Reddit's submit page takes the
     title and the body (or the link) in its query string, which is what
     the composer has always used, so this arrives with the post already
     written rather than as an empty box in a new community. */
  function crosspostHtml(m, post, opts) {
    opts = opts || {};
    const data = submitDataFor(post);
    const url = Crosspost.submitUrl(m.name, data);
    if (!url) return "";
    const isDraft = data !== post;
    const dest = (!isDraft && window.Util && Util.shareDestination) ? Util.shareDestination(post) : null;
    const self = isDraft
      ? !data.isLinkPost
      : (!!(dest && dest.kind === "self")
        || post.is_self
        || (post.url && /\/comments\//.test(post.url) && !post.is_video));
    const tip = isDraft
      ? `Open Reddit's submit page for r/${m.name} with the campaign's chosen headline and ${self ? "text" : "link"} filled in — edit both in "What gets submitted" above`
      : (dest && dest.note
        ? dest.note
        : (`Open Reddit's submit page for r/${m.name} with this post's title and `
          + (self ? "body" : "destination link") + " already filled in"));
    /* Weight follows evidence. A community with nothing loaded has no
       hour and no comparison behind it, so a row of them all shouting
       in the same colour as a graded suggestion would be the card
       pushing hardest exactly where it knows least. */
    const tone = opts.quiet ? "tiny" : `${opts.lead ? "small primary" : "tiny"} submit-link`;
    return `<a class="btn ${tone} focus-xpost"
               data-action="focus-crosspost" data-sub="${esc(m.name)}"
               href="${esc(url)}" target="_blank" rel="noopener"
               title="${esc(tip)}">${opts.lead ? `Cross-post to r/${esc(m.name)}` : "Cross-post"}</a>`;
  }

  /* Freeze this suggestion into the Planner sidebar. The button carries
     the move's key; the handler snapshots community, suggested time and
     the prefilled submit link, so later syncs cannot move any of it. */
  function planBtnHtml(m, post) {
    if (!window.Planner || !post) return "";
    if (Planner.has(post.id, m.name)) {
      return `<button type="button" class="btn tiny ghost is-planned" data-action="focus-plan-open"
                      title="Already in your planner — open it">In plan ✓</button>`;
    }
    return `<button type="button" class="btn tiny ghost" data-action="focus-plan-add" data-key="${esc(m.key)}"
                    title="Freeze this move into the Planner — community, suggested time and the prefilled cross-post link stay exactly as they are now">＋ Plan</button>`;
  }

  /* The three signals, in the same order and the same shape everywhere,
     so a row can be read across rather than parsed. */
  function signalsHtml(m) {
    const gain = NextMove.gainLabel(m.ratio);
    const floor = m.graded && m.ratioLow && m.ratioLow > 1.02
      ? `at least ${m.ratioLow.toFixed(1).replace(/\.0$/, "")}×`
      : "";
    const ruleBit = rulesSig(m);
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
        ${ruleBit}
      </div>
    `;
  }

  function rulesSig(m) {
    if (!m || !m.rules || !m.rules.rule) return "";
    if (m.rules.ok) {
      const tip = m.rules.rule.note || "This post's format clears this community's posting rules.";
      return `<span class="focus-sig focus-sig-rules is-ok" title="${esc(tip)}"><b>rules</b> ok</span>`;
    }
    /* Soft failure — uncertain, not banned. Shown so the user can
       decide, rather than silently demoted. */
    const why = (m.ruleReasons && m.ruleReasons[0]) || "may not fit the rules";
    return `<span class="focus-sig focus-sig-rules is-warn" title="${esc(m.rules.rule.note || why)}"><b>rules</b> ${esc(why)}</span>`;
  }

  /* Why this community, and when — the two answers that used to live in
     two other tabs.
     
     The bars were only ever drawn in a campaign's Discover panel and the
     scatter-and-curve only on the dashboard's Timing tab, so acting on a
     single recommendation meant reading a number here, leaving to see
     what it was made of, and leaving again to see the hours behind the
     hour. Three places, one question. They are folded into the row they
     describe now.

     Collapsed by default. The list is the thing you scan; this is the
     thing you open once you have a candidate, and a phone cannot show
     eight charts and still be a list. The chart mounts on first open,
     not on render, for the same reason. */
  function detailHtml(m) {
    if (!m.signals && !m.measured) return "";
    const facts = m.row ? UI.timingFactsHtml(m.row) : "";
    return `
      <details class="move-detail" data-move-detail="${esc(m.key)}">
        <summary title="The four parts of the match, and the hours behind the hour">Why here, and when</summary>
        <div class="move-detail-body">
          ${m.signals ? UI.matchMetersHtml(m.signals) : ""}
          ${m.overlapTerms && m.overlapTerms.length
            ? `<p class="move-detail-terms">Shares ${m.overlapTerms.slice(0, 6).map((t) => `<code>${esc(t)}</code>`).join(" ")}</p>`
            : ""}
          ${m.measured && m.row
            ? `<div class="chart-wrap short" data-move-chart="${esc(m.key)}"><canvas></canvas></div>
               ${facts ? `<div class="timing-facts">${facts}</div>` : ""}`
            : `<p class="hint">Nothing loaded here yet, so there is no chart and no clock. Load it and this fills in.</p>`}
        </div>
      </details>`;
  }

  /* Charts are mounted when a detail is first opened, and only once.
     Eight timing curves rendered up front is most of a second on a
     phone, spent on panels that are closed. */
  function mountDetailChart(details) {
    if (!details || details.dataset.charted === "1") return;
    const slot = details.querySelector("[data-move-chart]");
    if (!slot || !window.Charts || !window.Chart) return;
    const key = slot.getAttribute("data-move-chart");
    const result = focused() && resultFor(focused());
    if (!result) return;
    const all = (result.moves || []).concat(result.unmeasured || []);
    const move = all.find((m) => m.key === key);
    if (!move || !move.row) return;
    try {
      Charts.mount(slot, { kind: "timingCurve", data: move.row, opts: { compact: true } });
      details.dataset.charted = "1";
    } catch (err) {
      console.warn("[focus] chart for r/" + key + ":", err && err.message);
    }
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

  /* The row used to be one big button that drilled into the timing
     chart. It now carries a cross-post link, and a link inside a
     role="button" is both an accessibility error and an easy way to
     drill when you meant to post. Two named actions instead. */
  function moveHtml(m, post) {
    const whenLabel = !m.graded
      ? "any time"
      : m.when
        ? (m.when.open ? "open now" : m.when.label)
        : m.slotLabel;
    return `
      <li class="focus-move" data-verdict="${esc(m.verdict)}">
        <div class="focus-move-head">
          <span class="focus-move-sub">r/${esc(m.name)}</span>
          ${verdictBadge(m)}
          <span class="focus-move-when">${esc(whenLabel)}</span>
        </div>
        ${signalsHtml(m)}
        <div class="focus-move-actions">
          ${crosspostHtml(m, post)}
          ${planBtnHtml(m, post)}
        </div>
        ${detailHtml(m)}
      </li>
    `;
  }

  /* Nothing loaded here, so there is no hour and no comparison — but
     the post still reads like the place, and "you cannot measure it"
     is a poor reason to withhold the one action that needs no
     measurement. Load first if you want the numbers. */
  function unmeasuredHtml(m, post) {
    return `
      <li class="focus-unmeasured-row">
        <span class="focus-move-sub">r/${esc(m.name)}</span>
        <span class="focus-sig"><b>${m.fit}</b> match</span>
        <span class="focus-unmeasured-meta">${esc(m.viaSphere ? `via ${m.viaSphere}` : (m.record && m.record.subscribers ? `${Util.fmtNum(m.record.subscribers)} members` : "in the catalog"))}</span>
        <span class="focus-unmeasured-actions">
          ${crosspostHtml(m, post, { quiet: true })}
          ${planBtnHtml(m, post)}
          <button type="button" class="btn tiny" data-action="focus-load-sub" data-sub="${esc(m.name)}"
                  title="Pull this community's posts so it gets a clock and a comparison like the rest">${m.loaded ? "Sync" : "Load"}</button>
        </span>
      </li>
    `;
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

  /* Repaint in place, for handlers elsewhere that changed something the
     card is showing (a cross-post opened from the run, say). */
  View.repaint = render;

  /* Called by the dashboard whenever it repaints the Summary tab. */
  View.paint = function (timingModel, signature) {
    timing = timingModel || null;
    if (signature !== dataSignature) {
      dataSignature = signature || "";
      /* Timing moved under it, so any cached ranking is stale. */
      cache.clear();
    }
    render();
    if (window.SyndicateView && SyndicateView.paintPlanCarousel) {
      SyndicateView.paintPlanCarousel();
    }
    if (focusId && focused() && !resultFor(focused())) rank();
  };

  /* Send a post here from anywhere — the posts table, the detail panel,
     the analyse dialog, Syndicate.
     opts.related  a Discovery.forPost-shaped result to reuse so Syndicate
                   does not re-rank from scratch without news spheres */
  View.focusPost = function (post, opts) {
    if (!post) return;
    opts = opts || {};
    focusId = post.id;
    lastError = "";
    if (post.syndicated || String(post.id || "").indexOf("art_") === 0) {
      focusDraft = post;
      try { localStorage.removeItem(KEY); } catch (_) {}
    } else {
      focusDraft = null;
      if (window.Analyze && Analyze.adopt) Analyze.adopt(post);
      try { localStorage.setItem(KEY, focusId); } catch (_) {}
    }

    Router.go("dashboard");
    if (window.DashboardView) DashboardView.goToSection("plan");
    const card = document.getElementById("focus-card");
    if (card) card.scrollIntoView({ block: "start", behavior: "smooth" });

    if (opts.related && window.NextMove) {
      busy = true;
      render();
      NextMove.rank(post, {
        related: opts.related,
        timing: timing,
        exclude: alreadyIn(post),
        live: false,
      }).then((result) => {
        cache.set(post.id, { signature: dataSignature, result: result });
      }).catch((err) => {
        lastError = (err && err.message) || String(err);
      }).finally(() => {
        busy = false;
        render();
      });
      return;
    }
    render();
    rank();
    ensureAudience(post).catch(() => {});
    /* Thin image posts: kick OCR in the background so Plan can rematch
     * on the screenshot text once Tesseract finishes (no cloud AI). */
    if (window.ImageText && ImageText.isImagePost(post)
        && window.Util && Util.postIsTextThin(post) && !post.image_text) {
      runImageText(post, { interactive: false }).catch(() => {});
    }
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

    Dom.delegate(document, "click", '[data-action="focus-open-feed"]', () => {
      const post = focused();
      if (!post || !window.FeedView) return;
      FeedView.openPost(post, { title: "r/" + (post.subreddit || "posts") });
    });

    Dom.delegate(document, "click", '[data-action="focus-ocr"]', (e, btn) => {
      const post = focused();
      if (!post || !window.ImageText) return;
      runImageText(post, { force: btn.dataset.force === "1", interactive: true });
    });

    Dom.delegate(document, "click", '[data-action="focus-ocr-clear"]', () => {
      const post = focused();
      if (!post || !window.ImageText) return;
      ImageText.clear(post);
      cache.delete(post.id);
      if (window.AppState && AppState.postRelated) AppState.postRelated.delete(post.id);
      try { Util.toast("Image text discarded — re-ranking from title/flair.", "ok"); } catch (_) {}
      busy = false;
      rank();
    });

    /* The link opens Reddit itself — no preventDefault. All this does
       is remember that it happened, so the card can ask about it once
       the user comes back. */
    Dom.delegate(document, "click", '[data-action="focus-crosspost"]', (e, el) => {
      const post = focused();
      if (!post || !el.dataset.sub) return;
      Crosspost.markOpened(post.id, el.dataset.sub);
      /* After the handoff, or iOS Safari takes the repaint as the page
         changing under the tap and drops the new tab. */
      setTimeout(render, 400);
    });

    Dom.delegate(document, "submit", "[data-focus-posted]", (e, form) => {
      e.preventDefault();
      const post = focused();
      const input = form.querySelector('input[name="url"]');
      if (!post || !input) return;
      trackPasted(post, input.value);
    });

    Dom.delegate(document, "click", '[data-action="focus-posted-dismiss"]', () => {
      const post = focused();
      if (!post) return;
      Crosspost.clearOpened(post.id);
      render();
    });

    /* Only reachable when copies already exist — see reachHtml. It
       deliberately does not navigate: the campaign is a total, and the
       recommendations the user is working through are here. */
    Dom.delegate(document, "click", '[data-action="focus-track"]', () => {
      const post = focused();
      if (!post) return;
      try {
        const made = Crosspost.track(post);
        Util.toast(`Tracking ${made.posts.length} posts as "${made.campaign.name}".`, "ok");
        App.populateCampaignSelectors();
        App.publishCampaign(made.campaign);
        render();
      } catch (err) {
        Util.toast("Couldn't track these: " + ((err && err.message) || err), "err");
      }
    });

    Dom.delegate(document, "click", '[data-action="focus-open-campaign"]', (e, el) => {
      if (el.dataset.campaign) App.openCampaign(el.dataset.campaign);
    });

    /* ＋ Plan — snapshot a suggestion into the Planner sidebar. The
     * submit URL is built NOW (campaign compose choices included), and
     * the suggested slot is resolved to a concrete timestamp, so the
     * entry is a record of the original intention rather than a live
     * recommendation that drifts with the next sync. */
    Dom.delegate(document, "click", '[data-action="focus-plan-add"]', (e, btn) => {
      const post = focused();
      if (!post || !window.Planner) return;
      const result = resultFor(post);
      if (!result) return;
      const key = btn.dataset.key;
      const all = (result.moves || []).concat(result.unmeasured || []);
      const m = all.find((x) => x && x.key === key);
      if (!m) return;

      /* Freeze the community's own recommended window — the time the
       * card headlines, already clipped to the I can post slider.
       * The old cascade "on the run" slot was a stagger so two rooms
       * did not share an hour; that is not the recommended time. */
      let targetTime = null;
      if (m.when && m.when.date) targetTime = new Date(m.when.date).getTime();
      if (!Number.isFinite(targetTime)) targetTime = null;

      const whenLabel = !m.graded
        ? "any time"
        : m.when
          ? (m.when.open ? `now, until ${m.when.closesAt}` : m.when.label)
          : (m.slotLabel || "any time");

      const data = submitDataFor(post);
      const noteBits = [`${m.fit} match`];
      const gain = NextMove.gainLabel ? NextMove.gainLabel(m.ratio) : "";
      if (gain) noteBits.push(gain);

      const made = Planner.add({
        postId: post.id,
        campaignId: post.campaignId || "",
        postTitle: (data !== post && data.title) ? data.title : (post.title || ""),
        sub: m.name,
        submitUrl: Crosspost.submitUrl(m.name, data) || "",
        whenLabel: whenLabel,
        targetTime: targetTime,
        note: noteBits.join(" · "),
      });
      if (window.Util && Util.toast) {
        Util.toast(made.created
          ? `Planned: r/${m.name} · ${whenLabel}. It's frozen in the Planner.`
          : `Updated the planned move for r/${m.name}.`, "ok");
      }
      render();
    });

    Dom.delegate(document, "click", '[data-action="focus-plan-open"]', () => {
      if (window.Planner) Planner.open();
    });

    function rerankFromTune() {
      const post = focused();
      if (!post) return;
      cache.delete(post.id);
      busy = false;
      rank();
    }

    let tuneTimer = 0;
    function saveTune(patch) {
      const post = focused();
      const campaign = focusedCampaign(post);
      if (!campaign) return;
      const tune = Object.assign({}, campaign.tune || {}, patch);
      Campaigns.update(campaign.id, { tune: tune });
      if (tuneTimer) window.clearTimeout(tuneTimer);
      tuneTimer = window.setTimeout(() => {
        tuneTimer = 0;
        rerankFromTune();
      }, 350);
    }

    Dom.delegate(document, "input", "#focus-tune-extra", (e, input) => {
      saveTune({ extra: input.value });
    });
    Dom.delegate(document, "input", "#focus-tune-minfit", (e, input) => {
      const n = Number(input.value);
      saveTune({ minFit: Number.isFinite(n) && n > 0 ? n : 0 });
    });
    Dom.delegate(document, "change", "#focus-tune-loaded", (e, input) => {
      saveTune({ loadedOnly: !!input.checked });
    });

    Dom.delegate(document, "click", '[data-action="focus-roster-rank"]', (e, btn) => {
      const campaign = focusedCampaign(focused());
      if (!campaign) return;
      const kind = btn.dataset.kind;
      const id = btn.dataset.postId;
      if (kind === "post") {
        const p = Campaigns.resolvePosts(campaign).find((x) => x && x.id === id);
        if (p) View.focusPost(Object.assign({}, p, { campaignId: campaign.id }));
        return;
      }
      const theme = campaign.theme || {};
      const article = (window.Syndicate && Syndicate.articles)
        ? Syndicate.articles().find((a) => a && (a.id === theme.articleId || a.link === theme.articleLink))
        : null;
      const draft = article
        ? Object.assign({}, article, {
            id: article.id && String(article.id).indexOf("art_") === 0 ? article.id : "art_" + article.id,
            syndicated: true,
            campaignId: campaign.id,
            source_label: article.source || article.feedTitle || "Theme article",
          })
        : {
            id: id || "art_theme",
            syndicated: true,
            campaignId: campaign.id,
            title: theme.label || campaign.name,
            url: theme.articleLink || "",
            selftext: (theme.keywords || []).join(", "),
            is_self: false,
            source_label: "Theme article",
          };
      View.focusPost(draft);
    });

    /* Campaign composer — headline typing and source picks patch the
     * campaign record and rewrite the submit links in place. */
    let composeTimer = 0;
    Dom.delegate(document, "input", "#focus-compose-title", (e, input) => {
      if (composeTimer) window.clearTimeout(composeTimer);
      composeTimer = window.setTimeout(() => {
        composeTimer = 0;
        saveCompose({ title: input.value });
        updateSubmitLinks();
      }, 200);
    });
    Dom.delegate(document, "change", "#focus-compose-headline-pick", (e, select) => {
      if (!select.value) return;
      const input = document.getElementById("focus-compose-title");
      if (input) input.value = select.value;
      saveCompose({ title: select.value });
      select.value = "";
      updateSubmitLinks();
    });
    Dom.delegate(document, "change", "#focus-compose-source", (e, select) => {
      saveCompose({ source: select.value });
      updateSubmitLinks();
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

    /* `toggle` does not bubble, so it is caught on the way down. */
    document.addEventListener("toggle", (e) => {
      const d = e.target;
      if (d && d.matches && d.matches("[data-move-detail]") && d.open) mountDetailChart(d);
    }, true);

    /* A click anywhere else puts the typeahead away. */
    document.addEventListener("click", (e) => {
      if (e.target.closest && e.target.closest(".focus-field")) return;
      closeSuggestions();
    });
  };

  window.FocusView = View;
})();
