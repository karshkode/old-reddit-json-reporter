/* =====================================================================
 * RESET
 * ---------------------------------------------------------------------
 * "Start over" without throwing away the work worth keeping.
 *
 * The old Full reset was a confirm() box that cleared cached posts and
 * nothing else — so it could neither give you a genuinely clean slate
 * (subreddits and preferences survived it) nor promise that anything
 * in particular would survive. A yes/no dialog cannot offer a choice,
 * and the choice is the whole point: the expensive thing to lose is a
 * campaign, because a campaign is hand-curated and unrecoverable,
 * while cached posts are one fetch away from coming back.
 *
 * So resetting is scoped. Each scope is a checkbox with its own count,
 * and the defaults clear the cheap-to-replace things while leaving
 * campaigns alone. Keeping campaigns also keeps the subreddits they
 * post in, which would otherwise be swept up by the subreddit scope
 * and leave those campaigns pointing at communities no longer loaded.
 *
 * Nothing here touches the network, including the counts: a dialog
 * that had to wait on the archive before it could say what it was
 * about to delete would be worse than one that occasionally
 * undercounts a campaign's subreddits.
 * ===================================================================== */
(function () {
  const Reset = {};

  /* Keys owned by other modules that no module offers to clear. State's
   * own keys are handled through AppState so its in-memory copy stays
   * in step. */
  const PREF_KEYS = ["rj.savedSearches", "rj.view", "rj.volClaims", "rj.volName"];
  const DRAFT_PREFIX = "rj.composerDraft.";
  const FOCUS_KEY = "rj.focusPost";

  const SCOPES = [
    { key: "posts", label: "Cached posts", on: true },
    { key: "subs", label: "Loaded subreddits", on: true },
    { key: "index", label: "Community index", on: false },
    { key: "campaigns", label: "Campaigns", on: false },
    { key: "prefs", label: "Preferences and drafts", on: false },
  ];

  let picked = null;   // key -> boolean, persists for the page session
  let plan = null;     // latest counts, recomputed on open

  function lc(s) { return String(s || "").toLowerCase(); }
  function esc(s) { return Util.escapeHtml(String(s == null ? "" : s)); }
  /* Exact, not abbreviated. "4.8k posts" is fine on a dashboard tile and
   * wrong in a dialog whose job is to say precisely what it will
   * destroy. */
  function num(n) { return Number(n || 0).toLocaleString(); }
  function plural(n, one, many) { return `${num(n)} ${n === 1 ? one : (many || one + "s")}`; }

  function lsKeys() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
    } catch (_) {}
    return out.filter(Boolean);
  }

  function drop(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  }

  /* ------------------------------------------------------------------
   * What the campaigns depend on
   * ------------------------------------------------------------------ */

  /* The subreddits the saved campaigns actually post in.
   *
   * A campaign stores post IDs, not subreddit names, so this resolves
   * them against three local sources, cheapest first: the summaries
   * the dashboard has already computed, the posts in memory, and the
   * on-disk post cache. A post ID that none of the three can resolve
   * is simply not counted — the effect is that reset keeps slightly
   * less than it might, never that it deletes something it promised
   * to keep, since only loaded subreddits are ever protected anyway. */
  Reset.campaignSubs = async function () {
    const found = new Map();   // lowercase -> spelling as seen
    const camps = Campaigns.list();
    if (!camps.length) return found;

    const wanted = new Set();
    for (const c of camps) for (const id of (c.postIds || [])) wanted.add(String(id));

    const note = (name) => {
      const n = String(name || "").trim();
      if (n) found.set(n.toLowerCase(), n);
    };

    const summaries = AppState.campaignSummaries || {};
    for (const c of camps) {
      const s = summaries[c.id];
      if (s && Array.isArray(s.subs)) s.subs.forEach(note);
    }

    for (const p of AppState.posts || []) {
      if (p && wanted.has(String(p.id))) note(p.subreddit);
    }

    try {
      const cached = typeof PostCache === "undefined" ? null : await PostCache.load();
      for (const p of (cached && cached.posts) || []) {
        if (p && wanted.has(String(p.id))) note(p.subreddit);
      }
    } catch (_) {}

    return found;
  };

  /* Counts for the dialog, plus the list of subreddits that keeping the
   * campaigns would protect. */
  Reset.plan = async function () {
    const campSubs = await Reset.campaignSubs();
    const known = AppState.knownSubs || [];
    const inView = (AppState.posts || []).length;
    const onDisk = (AppState.cache && AppState.cache.cachedCount) || 0;
    return {
      /* Usually the same number, but a cache that has not been hydrated
       * into the view yet still has posts to clear, and a row reading
       * "0 posts" beside an enabled checkbox would be a lie. */
      posts: Math.max(inView, onDisk),
      inView: inView,
      subs: known.length,
      campaigns: Campaigns.list().length,
      /* Only subreddits that are both loaded and used by a campaign can
       * be "kept" — reset never adds anything back. */
      protectedSubs: known.filter((s) => campSubs.has(lc(s))),
      indexed: typeof SubIndex === "undefined" ? 0 : SubIndex.size(),
      drafts: lsKeys().filter((k) => k.indexOf(DRAFT_PREFIX) === 0).length,
    };
  };

  /* ------------------------------------------------------------------
   * Doing it
   * ------------------------------------------------------------------ */

  /* Returns a list of human-readable phrases describing what went.
   * A scope that turned out to hold nothing contributes no phrase, so
   * the confirmation never reports clearing "0 subreddits". */
  Reset.apply = async function (scopes) {
    scopes = scopes || {};
    const cleared = [];
    const report = (n, one, many) => { if (n > 0) cleared.push(plural(n, one, many)); };

    /* Resolved before anything is cleared: the post cache is one of the
     * sources that answers which subreddits a campaign posts in, and
     * clearing posts first would take the answer with it. */
    const keep = new Set();
    if (!scopes.campaigns && scopes.subs) {
      const campSubs = await Reset.campaignSubs();
      for (const s of AppState.knownSubs) if (campSubs.has(lc(s))) keep.add(lc(s));
    }

    if (scopes.posts) {
      const n = Math.max((AppState.posts || []).length,
        (AppState.cache && AppState.cache.cachedCount) || 0);
      App.clearCachedPosts({ silent: true });
      /* Both of these are post ids and nothing else. Left behind they
       * would point at posts that no longer exist: a placement card
       * focused on a ghost, and cross-post links between two of them. */
      drop(FOCUS_KEY);
      if (typeof Crosspost !== "undefined") Crosspost.reset();
      report(n, "post");
    }

    if (scopes.subs) {
      const doomed = AppState.knownSubs.filter((s) => !keep.has(lc(s)));
      const removed = doomed.length ? AppState.removeSubs(doomed) : [];
      report(removed.length, "subreddit");
    }

    if (scopes.index && typeof SubIndex !== "undefined") {
      const n = SubIndex.size();
      try { await SubIndex.clear(); } catch (_) {}
      if (n > 0) cleared.push(`the index for ${plural(n, "community", "communities")}`);
    }

    if (scopes.campaigns) {
      const n = Campaigns.clear();
      /* Composer drafts are keyed by campaign id, so without this they
       * would outlive every campaign that could open them. */
      for (const k of lsKeys()) if (k.indexOf(DRAFT_PREFIX) === 0) drop(k);
      AppState.openCampaignId = null;
      AppState.campaignSummaries = {};
      report(n, "campaign");
    }

    if (scopes.prefs) {
      for (const k of PREF_KEYS) drop(k);
      AppState.listing = "hot";
      AppState.timeWindow = "week";
      AppState.limit = 100;
      AppState.activeSpheres = [];
      AppState.persist();
      if (typeof Theme !== "undefined") Theme.set("system");
      syncFilterControls();
      cleared.push("saved preferences");
    }

    AppState.persist();
    return cleared;
  };

  /* The listing/time/limit selects are populated once at startup, so a
   * preference reset has to put them back by hand or they keep showing
   * values the state no longer holds. */
  function syncFilterControls() {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = String(v);
    };
    set("listing-select", AppState.listing);
    set("time-select", AppState.timeWindow);
    set("limit-select", AppState.limit);
  }

  /* ------------------------------------------------------------------
   * Dialog
   * ------------------------------------------------------------------ */

  function defaults() {
    const out = {};
    for (const s of SCOPES) out[s.key] = s.on;
    return out;
  }

  /* One line per scope saying what it holds right now, so the choice is
   * made against real numbers rather than a category name. */
  function metaFor(key) {
    const keeping = !picked.campaigns && plan.campaigns > 0;
    switch (key) {
      case "posts":
        return plan.posts
          ? `${plural(plan.posts, "post")} on this device · fetched again on the next Go`
          : "nothing cached right now";
      case "subs": {
        if (!plan.subs) return "none loaded";
        const kept = keeping ? plan.protectedSubs.length : 0;
        return kept
          ? `${plural(plan.subs, "subreddit")} loaded · ${num(kept)} kept for your campaigns`
          : `${plural(plan.subs, "subreddit")} loaded`;
      }
      case "index":
        return plan.indexed
          ? `${plural(plan.indexed, "community", "communities")} described · rebuilt as you search`
          : "empty";
      case "campaigns":
        return plan.campaigns
          ? `${plural(plan.campaigns, "campaign")} · cannot be recovered`
          : "none saved";
      case "prefs":
        return plan.drafts
          ? `theme, filters, saved searches, ${plural(plan.drafts, "draft")}`
          : "theme, filters, saved searches";
      default:
        return "";
    }
  }

  /* The count is the point of the row, so a scope holding nothing is
   * not worth a checkbox — but campaigns stay visible even at zero,
   * because their row is where the promise to keep them is made. */
  function isEmpty(key) {
    switch (key) {
      case "posts": return !plan.posts;
      case "subs": return !plan.subs;
      case "index": return !plan.indexed;
      case "campaigns": return false;
      case "prefs": return false;
      default: return false;
    }
  }

  function renderScopes() {
    const host = document.getElementById("reset-scopes");
    if (!host) return;
    host.innerHTML = SCOPES.map((s) => {
      const off = isEmpty(s.key);
      const on = picked[s.key] && !off;
      return `
        <label class="reset-scope${off ? " is-empty" : ""}${on ? " is-on" : ""}">
          <input type="checkbox" data-reset-scope="${esc(s.key)}" ${on ? "checked" : ""} ${off ? "disabled" : ""} />
          <span class="reset-scope-body">
            <span class="reset-scope-name">${esc(s.label)}</span>
            <span class="reset-scope-meta">${esc(metaFor(s.key))}</span>
          </span>
        </label>`;
    }).join("");
  }

  /* The warning proper: one sentence for what goes, one for what stays.
   * Both are spelled out even when the answer is "nothing", since a
   * reset dialog that says only what it destroys leaves the reader to
   * infer the rest. */
  function renderSummary() {
    const el = document.getElementById("reset-summary");
    const btn = document.getElementById("reset-confirm");
    if (!el) return;

    const going = [];
    if (picked.posts && !isEmpty("posts")) going.push(plural(plan.posts, "cached post"));
    if (picked.subs && !isEmpty("subs")) {
      const kept = picked.campaigns ? 0 : plan.protectedSubs.length;
      going.push(kept
        ? `${num(plan.subs - kept)} of ${plural(plan.subs, "subreddit")}`
        : plural(plan.subs, "subreddit"));
    }
    if (picked.index && !isEmpty("index")) going.push("the community index");
    if (picked.campaigns && plan.campaigns) going.push(plural(plan.campaigns, "campaign"));
    if (picked.prefs) going.push("your preferences");

    const staying = [];
    if (!picked.campaigns && plan.campaigns) {
      const kept = picked.subs ? plan.protectedSubs.length : 0;
      staying.push(kept
        ? `${plural(plan.campaigns, "campaign")} and the ${plural(kept, "subreddit")} they post in`
        : plural(plan.campaigns, "campaign"));
    }
    if (!picked.subs && plan.subs) staying.push(`all ${plural(plan.subs, "subreddit")}`);
    if (!picked.prefs) staying.push("your preferences");

    const danger = picked.campaigns && plan.campaigns > 0;
    el.className = "reset-summary" + (danger ? " is-danger" : "");
    el.innerHTML = going.length
      ? `<strong>Clears ${esc(list(going))}.</strong>`
        + (staying.length ? ` Keeps ${esc(list(staying))}.` : "")
        + ` This cannot be undone.`
      : `Nothing selected.`;

    if (btn) btn.disabled = !going.length;
  }

  function list(parts) {
    if (parts.length <= 1) return parts[0] || "";
    /* A serial comma when one of the items has an "and" inside it —
     * "campaigns and the subreddits they post in" is one of them, and
     * without the comma the sentence grows a second "and" that reads
     * as though the subreddits were a separate thing being kept. */
    const nested = parts.some((s) => s.indexOf(" and ") !== -1);
    const sep = nested ? ", and " : " and ";
    return parts.slice(0, -1).join(", ") + sep + parts[parts.length - 1];
  }

  /* Rebuilding the rows throws away the checkbox the keyboard was on,
   * which for someone tabbing through the scopes means every tick sends
   * them back to the top of the dialog. */
  function paint() {
    const active = document.activeElement;
    const was = active && active.dataset ? active.dataset.resetScope : null;
    renderScopes();
    renderSummary();
    if (!was) return;
    const back = document.querySelector(`[data-reset-scope="${was}"]`);
    if (back) try { back.focus({ preventScroll: true }); } catch (_) {}
  }

  Reset.open = async function () {
    const modal = document.getElementById("reset-modal");
    if (!modal) return;
    if (!picked) picked = defaults();
    plan = await Reset.plan();
    /* A scope with nothing in it cannot be selected, so make sure it is
     * not still counted as selected from a previous open. */
    for (const s of SCOPES) if (isEmpty(s.key)) picked[s.key] = false;
    paint();
    modal.hidden = false;
    document.body.classList.add("modal-open");
    /* The first scope, not the close button — landing on × puts a red
     * focus ring in the header of a dialog that is already about
     * deleting things, which reads as something having gone wrong. */
    const first = modal.querySelector("[data-reset-scope]:not([disabled])")
      || modal.querySelector("button");
    if (first) try { first.focus({ preventScroll: true }); } catch (_) {}
  };

  Reset.close = function () {
    const modal = document.getElementById("reset-modal");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove("modal-open");
    const back = document.getElementById("full-reset-btn");
    if (back) try { back.focus({ preventScroll: true }); } catch (_) {}
  };

  async function confirmReset() {
    const scopes = Object.assign({}, picked);
    const btn = document.getElementById("reset-confirm");
    if (btn) { btn.disabled = true; btn.textContent = "Resetting…"; }

    let cleared = [];
    try {
      cleared = await Reset.apply(scopes);
    } finally {
      if (btn) btn.textContent = "Reset";
    }

    Reset.close();

    /* Campaign detail is the one view that can outlive its own subject,
     * so step back to the list before repainting into a missing one. */
    if (scopes.campaigns && Router.current() === "campaign") Router.go("campaigns");
    App.renderChips();
    Router.invalidate();
    App.rerenderAll();
    App.updateRailCounts();
    if (scopes.posts) App.markPending("Data reset");

    Util.toast(cleared.length ? `Cleared ${list(cleared)}.` : "Nothing to clear.", "ok");
  }

  /* The undo this dialog cannot otherwise offer: the same session file
   * the Sync panel exports, downloaded from inside the warning, so a
   * reset someone turns out to regret is an import away from reversed.
   * Offered here rather than linked to, because sending the user to
   * another modal to fetch it is a step most would skip. */
  function downloadBackup() {
    try {
      const payload = Sync.collectPayload();
      const text = JSON.stringify(payload, null, 2);
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `reddit-campaign-syndicator-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const n = (payload.campaigns || []).length;
      Util.toast(`Backup downloaded — ${plural(n, "campaign")} and your subreddits.`, "ok");
    } catch (err) {
      Util.toast("Couldn't export a backup: " + ((err && err.message) || err), "err");
    }
  }

  Reset.wire = function () {
    const modal = document.getElementById("reset-modal");
    if (!modal) return;

    modal.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest && t.closest('[data-action="close-reset-modal"]')) {
        e.preventDefault();
        Reset.close();
        return;
      }
      if (t.closest && t.closest('[data-action="reset-backup"]')) {
        e.preventDefault();
        downloadBackup();
      }
    });

    modal.addEventListener("change", (e) => {
      const box = e.target.closest && e.target.closest("[data-reset-scope]");
      if (!box) return;
      picked[box.dataset.resetScope] = box.checked;
      /* Toggling campaigns changes what the subreddit row keeps, so the
       * whole panel is repainted rather than just this row. */
      paint();
    });

    const go = document.getElementById("reset-confirm");
    if (go) go.addEventListener("click", () => { confirmReset(); });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) Reset.close();
    });
  };

  window.Reset = Reset;
})();
