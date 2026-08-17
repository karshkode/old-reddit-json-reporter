/* =====================================================================
 * PLANNER — the follow-through list
 * ---------------------------------------------------------------------
 * Plan's suggestions are computed from whatever is loaded right now, so
 * they drift: sync tomorrow and the lead move may name a different
 * community or a different hour. That is correct behaviour for a
 * recommender and useless for follow-through. This module is the other
 * half: "＋ Plan" on any suggestion FREEZES it — community, the exact
 * time that was suggested, and the prefilled submit link (including a
 * campaign's composed headline/content at that moment) — into a
 * persistent list in a left-hand sidebar. The entry never re-ranks;
 * it is a record of the original intention, with the cross-post button
 * still live at the suggested time.
 *
 * Entry shape (localStorage `rj.planner`):
 *   { id, createdAt, status: "planned"|"posted",
 *     postId, campaignId, postTitle, sub,
 *     submitUrl,            — frozen at add time
 *     whenLabel,            — human words at add time ("tomorrow 14:00")
 *     targetTime,           — epoch ms of the suggested slot, or null
 *     note }                — one-line why ("49 match · 75.1× the reach")
 * ===================================================================== */
(function () {
  "use strict";

  const KEY = "rj.planner";
  const Planner = {};

  let mirror = null;
  let tick = 0;

  const esc = (s) => (window.Util && Util.escapeHtml)
    ? Util.escapeHtml(s == null ? "" : String(s))
    : String(s == null ? "" : s);

  function trunc(s, n) {
    const t = String(s == null ? "" : s);
    return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
  }

  /* ------------------------------------------------------------------
   * STORE
   * ------------------------------------------------------------------ */

  function ensure() {
    if (mirror !== null) return mirror;
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      mirror = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      mirror = [];
    }
    return mirror;
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(mirror)); } catch (_) {}
  }

  Planner.list = function () { return ensure().slice(); };

  Planner.get = function (id) {
    return ensure().find((e) => e && e.id === id) || null;
  };

  /* Is there already a live (not posted) entry for this content in this
   * community? Used to flip "＋ Plan" buttons to "In plan". */
  Planner.has = function (postId, sub) {
    const s = String(sub || "").toLowerCase();
    const p = String(postId || "");
    return ensure().some((e) => e && e.status === "planned"
      && String(e.sub || "").toLowerCase() === s
      && String(e.postId || "") === p);
  };

  /* Add an entry; deduped against live entries for the same post+sub so
   * tapping ＋ Plan twice cannot double the list. Returns
   * { entry, created }. */
  Planner.add = function (data) {
    ensure();
    const sub = String(data.sub || "").trim();
    if (!sub) return { entry: null, created: false };
    const existing = mirror.find((e) => e && e.status === "planned"
      && String(e.sub || "").toLowerCase() === sub.toLowerCase()
      && String(e.postId || "") === String(data.postId || ""));
    if (existing) {
      /* Refresh the frozen details — the user re-planned on purpose. */
      Object.assign(existing, {
        submitUrl: data.submitUrl || existing.submitUrl,
        whenLabel: data.whenLabel || existing.whenLabel,
        targetTime: data.targetTime != null ? data.targetTime : existing.targetTime,
        note: data.note || existing.note,
        postTitle: data.postTitle || existing.postTitle,
      });
      persist();
      paintBadges();
      renderList();
      return { entry: existing, created: false };
    }
    const entry = {
      id: Math.random().toString(36).slice(2, 10),
      createdAt: Date.now(),
      status: "planned",
      postId: String(data.postId || ""),
      campaignId: String(data.campaignId || ""),
      postTitle: String(data.postTitle || "").slice(0, 200),
      sub: sub,
      submitUrl: String(data.submitUrl || ""),
      whenLabel: String(data.whenLabel || "any time"),
      targetTime: Number.isFinite(data.targetTime) ? data.targetTime : null,
      note: String(data.note || "").slice(0, 160),
    };
    mirror.push(entry);
    persist();
    paintBadges();
    renderList();
    return { entry: entry, created: true };
  };

  Planner.update = function (id, patch) {
    ensure();
    const e = mirror.find((x) => x && x.id === id);
    if (!e) return null;
    Object.assign(e, patch || {});
    persist();
    paintBadges();
    renderList();
    return e;
  };

  Planner.remove = function (id) {
    ensure();
    mirror = mirror.filter((e) => e && e.id !== id);
    persist();
    paintBadges();
    renderList();
  };

  Planner.clearDone = function () {
    ensure();
    const n = mirror.length;
    mirror = mirror.filter((e) => e && e.status !== "posted");
    persist();
    paintBadges();
    renderList();
    return n - mirror.length;
  };

  /* Planned entries whose suggested time has arrived (or passed). */
  Planner.dueCount = function () {
    const now = Date.now();
    return ensure().filter((e) => e && e.status === "planned"
      && e.targetTime != null && e.targetTime <= now + 15 * 60000).length;
  };

  Planner.plannedCount = function () {
    return ensure().filter((e) => e && e.status === "planned").length;
  };

  /* ------------------------------------------------------------------
   * TIME WORDS
   * ------------------------------------------------------------------ */

  function fmtTarget(ms) {
    try {
      return new Date(ms).toLocaleString(undefined, {
        weekday: "short", hour: "numeric", minute: "2-digit",
      });
    } catch (_) { return ""; }
  }

  /* The countdown is the one live thing on an otherwise frozen entry —
   * the slot itself never moves, only how far away it is. */
  function countdown(e) {
    if (e.targetTime == null) return { label: "any time", state: "open" };
    const diff = e.targetTime - Date.now();
    const abs = Math.abs(diff);
    const h = Math.floor(abs / 3600000);
    const m = Math.round((abs % 3600000) / 60000);
    const span = h >= 48 ? `${Math.round(h / 24)}d` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    if (diff <= 15 * 60000 && diff > -90 * 60000) return { label: "due now", state: "due" };
    if (diff < 0) return { label: `missed by ${span}`, state: "late" };
    return { label: `in ${span}`, state: "wait" };
  }

  /* ------------------------------------------------------------------
   * DRAWER
   * ------------------------------------------------------------------ */

  function drawer() { return document.getElementById("planner-sheet"); }
  function backdrop() { return document.getElementById("planner-backdrop"); }

  Planner.isOpen = function () {
    const d = drawer();
    return !!(d && !d.hidden);
  };

  Planner.open = function () {
    const d = drawer(), b = backdrop();
    if (!d) return;
    d.hidden = false;
    if (b) b.hidden = false;
    renderList();
  };

  Planner.close = function () {
    const d = drawer(), b = backdrop();
    if (d) d.hidden = true;
    if (b) b.hidden = true;
  };

  Planner.toggle = function () {
    if (Planner.isOpen()) Planner.close();
    else Planner.open();
  };

  function entryHtml(e) {
    const cd = countdown(e);
    const posted = e.status === "posted";
    const stateBadge = posted
      ? `<span class="badge good">posted</span>`
      : cd.state === "due" ? `<span class="badge warn">due now</span>`
      : cd.state === "late" ? `<span class="badge bad">${esc(cd.label)}</span>`
      : "";
    const timeBits = [];
    if (e.whenLabel) timeBits.push(esc(e.whenLabel));
    if (e.targetTime != null) {
      timeBits.push(esc(fmtTarget(e.targetTime)));
      if (!posted && cd.state === "wait") timeBits.push(esc(cd.label));
    }
    return `
      <li class="planner-item${posted ? " is-posted" : ""}${cd.state === "due" && !posted ? " is-due" : ""}" data-planner-id="${esc(e.id)}">
        <div class="planner-item-head">
          <span class="planner-item-sub">r/${esc(e.sub)}</span>
          ${stateBadge}
        </div>
        <div class="planner-item-title" title="${esc(e.postTitle)}">${esc(trunc(e.postTitle || "(untitled)", 80))}</div>
        <div class="planner-item-meta meta">${timeBits.join(" · ")}${e.note ? `${timeBits.length ? " · " : ""}${esc(e.note)}` : ""}</div>
        <div class="planner-item-actions">
          ${!posted && e.submitUrl
            ? `<a class="btn tiny ${cd.state === "due" || cd.state === "late" || cd.state === "open" ? "primary" : ""} submit-link"
                  href="${esc(e.submitUrl)}" target="_blank" rel="noopener"
                  title="Open Reddit's submit page for r/${esc(e.sub)} exactly as it was prefilled when you planned this">Cross-post ↗</a>`
            : ""}
          ${!posted
            ? `<button type="button" class="btn tiny ghost" data-action="planner-posted" data-id="${esc(e.id)}"
                       title="Mark this move done">Posted ✓</button>`
            : ""}
          <button type="button" class="btn tiny ghost planner-remove" data-action="planner-remove" data-id="${esc(e.id)}"
                  aria-label="Remove from plan">×</button>
        </div>
      </li>`;
  }

  function renderList() {
    const host = document.getElementById("planner-list");
    if (!host) return;
    const all = ensure().slice();
    const planned = all.filter((e) => e && e.status === "planned")
      .sort((a, b) => {
        const at = a.targetTime == null ? Infinity : a.targetTime;
        const bt = b.targetTime == null ? Infinity : b.targetTime;
        return at - bt || a.createdAt - b.createdAt;
      });
    const done = all.filter((e) => e && e.status === "posted")
      .sort((a, b) => b.createdAt - a.createdAt);

    if (!planned.length && !done.length) {
      host.innerHTML = `
        <div class="empty planner-empty">
          <strong>Nothing planned yet</strong>
          <p>On the dashboard's Plan tab, tap <b>＋ Plan</b> on any suggestion.
          The community, the suggested time and the prefilled cross-post link are
          frozen here so tomorrow's data cannot move them.</p>
        </div>`;
      return;
    }

    host.innerHTML = `
      ${planned.length ? `<ol class="planner-items">${planned.map(entryHtml).join("")}</ol>` : `
        <p class="hint planner-none">Nothing left to do — everything planned is posted.</p>`}
      ${done.length ? `
        <details class="planner-done">
          <summary>${done.length} done</summary>
          <ol class="planner-items">${done.map(entryHtml).join("")}</ol>
          <button type="button" class="btn small ghost planner-clear-done" data-action="planner-clear-done">Clear done</button>
        </details>` : ""}`;
  }

  /* Counts on the rail link and the topbar pin. The badge shows how
   * many moves are waiting; it turns urgent when any slot has arrived. */
  function paintBadges() {
    const n = Planner.plannedCount();
    const due = Planner.dueCount();
    for (const id of ["rail-count-planner", "planner-count-top"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = String(n);
      el.hidden = !n;
      el.classList.toggle("is-due", due > 0);
    }
  }

  Planner.refresh = function () {
    paintBadges();
    if (Planner.isOpen()) renderList();
  };

  /* ------------------------------------------------------------------
   * WIRING
   * ------------------------------------------------------------------ */

  function mount() {
    if (!window.Dom) return;

    Dom.delegate(document, "click", '[data-action="planner-toggle"]', (e) => {
      e.preventDefault();
      Planner.toggle();
    });
    Dom.delegate(document, "click", '[data-action="planner-close"]', () => Planner.close());
    const b = backdrop();
    if (b) b.addEventListener("click", () => Planner.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && Planner.isOpen()) Planner.close();
    });

    Dom.delegate(document, "click", '[data-action="planner-posted"]', (e, btn) => {
      Planner.update(btn.dataset.id, { status: "posted" });
      if (window.Util && Util.toast) Util.toast("Marked posted — sync that community to pick the copy up.", "ok");
    });
    Dom.delegate(document, "click", '[data-action="planner-remove"]', (e, btn) => {
      Planner.remove(btn.dataset.id);
    });
    Dom.delegate(document, "click", '[data-action="planner-clear-done"]', () => {
      Planner.clearDone();
    });

    /* The countdowns and the due badge move with the clock, nothing
     * else does. One repaint a minute is plenty. */
    tick = window.setInterval(Planner.refresh, 60000);
    paintBadges();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.Planner = Planner;
})();
