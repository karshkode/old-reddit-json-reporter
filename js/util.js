/* Small utility helpers used everywhere. Plain global namespace `Util`. */
(function () {
  const Util = {};

  Util.fmtNum = function (n) {
    if (n == null || Number.isNaN(n)) return "—";
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.00$/, "") + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(n));
  };

  Util.fmtPct = function (n) {
    if (n == null || Number.isNaN(n)) return "—";
    return (n * 100).toFixed(0) + "%";
  };

  /* Returns the user's short timezone label, e.g. "EDT", "PST", "GMT+1".
   * Falls back to numeric "UTC±H[:MM]" if Intl can't resolve a name. */
  let _cachedTzLabel = null;
  Util.getTzLabel = function () {
    if (_cachedTzLabel) return _cachedTzLabel;
    try {
      const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date());
      const tz = parts.find((p) => p.type === "timeZoneName");
      if (tz && tz.value) return (_cachedTzLabel = tz.value);
    } catch (_) {}
    const off = -new Date().getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const h = Math.floor(Math.abs(off) / 60);
    const m = Math.abs(off) % 60;
    return (_cachedTzLabel = m ? "UTC" + sign + h + ":" + String(m).padStart(2, "0") : "UTC" + sign + h);
  };

  /* Local-time short formatter: YYYY-MM-DD HH:MM in the user's timezone. */
  Util.fmtDateShort = function (epochSeconds) {
    if (epochSeconds == null || epochSeconds === "" || Number.isNaN(+epochSeconds)) return "—";
    let t = +epochSeconds;
    if (!t) return "—";
    if (t > 1e12) t = t / 1000;
    const d = new Date(t * 1000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return yyyy + "-" + mm + "-" + dd + " " + hh + ":" + mi;
  };

  /* Relative age for a Unix timestamp. Accepts seconds (Reddit's
   * created_utc) or milliseconds; anything in the future — clock skew,
   * a feed dated ahead of the machine — collapses to "just now" so the
   * UI never prints "-15224s ago". The old path hit `diff < 60` for
   * every negative number and echoed the raw seconds. */
  Util.relTime = function (epochSeconds) {
    if (epochSeconds == null || epochSeconds === "" || Number.isNaN(+epochSeconds)) return "—";
    let t = +epochSeconds;
    if (!t) return "—";
    /* Milliseconds look like 1.7e12; Reddit seconds are ~1.7e9. */
    if (t > 1e12) t = t / 1000;
    const diff = Date.now() / 1000 - t;
    if (diff < 0 || diff < 45) return "just now";
    if (diff < 3600) return Math.round(diff / 60) + "m ago";
    if (diff < 86400) return Math.round(diff / 3600) + "h ago";
    if (diff < 86400 * 30) return Math.round(diff / 86400) + "d ago";
    if (diff < 86400 * 365) return Math.round(diff / (86400 * 30)) + "mo ago";
    return Math.round(diff / (86400 * 365)) + "y ago";
  };

  /* Undo leftover HTML entities in plain text — feed titles that ship
   * literally as "NYT &GT; TOP STORIES", double-encoded &amp;amp;, etc.
   * Safe to call on already-clean strings. */
  Util.decodeEntities = function (s) {
    if (s == null || s === "") return "";
    let str = String(s);
    if (str.indexOf("&") === -1) return str;
    if (typeof document !== "undefined") {
      const tmp = document.createElement("textarea");
      for (let i = 0; i < 2; i++) {
        if (str.indexOf("&") === -1) break;
        tmp.innerHTML = str;
        const next = tmp.value;
        if (next === str) break;
        str = next;
      }
    }
    /* Named entities some browsers leave alone when uppercased, plus
     * numeric forms that never went through a DOM. */
    return str
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
        const n = parseInt(h, 16);
        return Number.isFinite(n) ? String.fromCodePoint(n) : _;
      })
      .replace(/&#(\d+);/g, (_, d) => {
        const n = parseInt(d, 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : _;
      });
  };

  /* Local-time clock string — "14:23" — for the Posts table's "When"
   * column. Pairs with relTime so the user sees both "2h ago" AND
   * the actual hour-of-day, which matters when assessing whether a
   * sub's "best hour" recommendation is genuine or just an artifact
   * of which posts happened to survive the front-page rotation long
   * enough to be in the snapshot. */
  Util.fmtClockTime = function (epochSeconds) {
    if (epochSeconds == null || epochSeconds === "" || Number.isNaN(+epochSeconds)) return "";
    let t = +epochSeconds;
    if (!t) return "";
    if (t > 1e12) t = t / 1000;
    const d = new Date(t * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mi;
  };

  Util.escapeHtml = function (s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  /* Accepts any of:
   *   foo
   *   r/foo
   *   /r/foo
   *   https://www.reddit.com/r/foo/
   *   https://old.reddit.com/r/foo/comments/123/title
   *   https://reddit.com/r/foo
   * Returns the lowercased sub name, or "" if nothing usable found. */
  Util.normalizeSubName = function (s) {
    if (!s) return "";
    const t = String(s).trim();
    const m = t.match(/r\/([A-Za-z0-9_]{2,30})/i);
    if (m) return m[1].toLowerCase();
    return t.replace(/[^A-Za-z0-9_]/g, "").toLowerCase();
  };

  /* The readable body of a self post, cleaned up enough to be worth
   * tokenising. Raw selftext is markdown, and markdown is mostly
   * punctuation and URLs once you take the words out — a bare link
   * tokenises to "https www reddit com", which is vocabulary the post
   * does not actually have. Link text is kept, link targets are not.
   *
   * Returns "" for removed posts and for link posts with no body, so
   * callers can treat "no body" and "nothing worth reading" alike. */
  Util.postBody = function (post, limit) {
    if (!post || post.removed) return "";
    let s = String(post.selftext || "");
    if (!s || s === "[removed]" || s === "[deleted]") s = "";
    else {
      s = s
        .replace(/```[\s\S]*?```/g, " ")          /* fenced code */
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")    /* images */
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")  /* links: keep the text */
        .replace(/\bhttps?:\/\/\S+/gi, " ")       /* bare URLs */
        .replace(/\/?[ru]\/[A-Za-z0-9_-]+/g, " ") /* r/sub and u/user handles */
        .replace(/^&gt;.*$/gm, " ")               /* quoted text: someone else's words */
        .replace(/^>.*$/gm, " ")
        .replace(/&amp;#?\w+;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    /* Image / screenshot substance — captions first, then OCR when run. */
    const mediaBits = [post.media_captions, post.image_text]
      .map((t) => String(t || "").trim())
      .filter(Boolean);
    if (mediaBits.length) {
      s = (s ? s + " " : "") + mediaBits.join(" ");
    } else if (post.media_title && String(post.media_title).trim()
        && String(post.media_title).trim() !== String(post.title || "").trim()) {
      s = (s ? s + " " : "") + String(post.media_title).trim();
    }
    if (!s) return "";
    const cap = limit == null ? 4000 : limit;
    return s.length > cap ? s.slice(0, cap) : s;
  };

  /* Everything about a post that carries its subject: the headline, the
   * framing the community applied, and the body (including image text). */
  Util.postText = function (post, limit) {
    if (!post) return "";
    return [post.title || "", post.flair || "", Util.postBody(post, limit)]
      .filter(Boolean).join(" ");
  };

  /* True when the post has almost no subject text beyond title/flair —
   * typical of image and link posts before OCR. Discovery must not fill
   * that vacuum with the home subreddit's sidebar vocabulary. */
  Util.postIsTextThin = function (post) {
    if (!post) return true;
    const body = Util.postBody(post, 4000);
    return !body || body.length < 40;
  };

  /* Accept Reddit post IDs in any of these forms (mixed in one paste):
   *   1abcd2e
   *   t3_1abcd2e
   *   https://www.reddit.com/r/sub/comments/1abcd2e/some-title/
   *   https://old.reddit.com/r/sub/comments/1abcd2e/
   *   https://redd.it/1abcd2e
   *   /r/sub/comments/1abcd2e/
   * Tokens are split on commas / semicolons / whitespace. */
  Util.parseIdList = function (text) {
    if (!text) return [];
    const out = [];
    const seen = new Set();
    for (const raw of String(text).split(/[\s,;]+/)) {
      const tok = raw.trim();
      if (!tok) continue;
      let id = null;
      const mComments = tok.match(/comments\/([a-z0-9]{4,12})/i);
      if (mComments) id = mComments[1];
      else {
        const mShort = tok.match(/redd\.it\/([a-z0-9]{4,12})/i);
        if (mShort) id = mShort[1];
        else {
          // Only treat bare tokens as IDs if they're explicitly t3_-prefixed
          // OR they look like a Reddit base36 ID (contain at least one digit).
          // This stops "Check this out: https://reddit.com/r/x/comments/abc1234/y"
          // from also picking up "Check" and "this" as IDs.
          const t3 = /^t3_([a-z0-9]{4,12})$/i.exec(tok);
          if (t3) id = t3[1];
          else {
            const cleaned = tok.replace(/[^a-z0-9]/gi, "");
            if (/^[a-z0-9]{5,12}$/i.test(cleaned) && /\d/.test(cleaned)) id = cleaned;
          }
        }
      }
      if (!id) continue;
      const k = id.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  };

  Util.debounce = function (fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  };

  Util.uniqBy = function (arr, key) {
    const seen = new Set();
    const out = [];
    for (const v of arr) {
      const k = typeof key === "function" ? key(v) : v[key];
      if (!seen.has(k)) {
        seen.add(k);
        out.push(v);
      }
    }
    return out;
  };

  Util.average = function (arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  };

  Util.median = function (arr) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  Util.percentile = function (arr, p) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    const idx = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
    return a[idx];
  };

  /* A toast is glanced at for three and a half seconds, so anything past
   * a couple of lines is not going to be read — and on a phone a long
   * one covered the content it was reporting on. Callers that quote a
   * user-supplied name cannot know how long it will be, so the cap lives
   * here rather than at every call site. */
  const TOAST_MAX = 96;

  Util.toast = function (msg, kind) {
    const el = document.getElementById("toast");
    if (!el) return;
    const text = String(msg == null ? "" : msg);
    el.textContent = text.length > TOAST_MAX ? text.slice(0, TOAST_MAX - 1).trimEnd() + "…" : text;
    el.className = "toast" + (kind ? " " + kind : "");
    el.hidden = false;
    clearTimeout(Util._toastTimer);
    Util._toastTimer = setTimeout(() => (el.hidden = true), 3500);
  };

  /* Themed confirm — replaces abrasive window.confirm() with the same
   * modal shell as Session / Reset. Resolves true on confirm, false on
   * dismiss (backdrop, Escape, cancel). */
  Util.confirm = function (opts) {
    opts = opts || {};
    const modal = document.getElementById("confirm-modal");
    if (!modal) {
      const fallback = [opts.title, opts.body, opts.detail].filter(Boolean).join("\n\n");
      return Promise.resolve(window.confirm(fallback || "Continue?"));
    }

    if (Util._confirmResolve) {
      const prev = Util._confirmResolve;
      Util._confirmResolve = null;
      prev(false);
    }

    return new Promise((resolve) => {
      const titleEl = document.getElementById("confirm-modal-title");
      const bodyEl = document.getElementById("confirm-modal-body");
      const detailEl = document.getElementById("confirm-modal-detail");
      const okBtn = document.getElementById("confirm-modal-ok");
      const cancelBtn = document.getElementById("confirm-modal-cancel");

      if (titleEl) titleEl.textContent = opts.title || "Confirm";
      if (bodyEl) bodyEl.textContent = opts.body || "";
      if (detailEl) {
        const detail = opts.detail || "";
        detailEl.hidden = !detail;
        detailEl.textContent = detail;
      }
      if (okBtn) okBtn.textContent = opts.confirmLabel || "Continue";
      if (cancelBtn) cancelBtn.textContent = opts.cancelLabel || "Not now";

      modal.classList.remove("is-warn", "is-danger", "is-info");
      const tone = opts.tone || "info";
      if (tone === "warn" || tone === "danger" || tone === "info") {
        modal.classList.add("is-" + tone);
      }
      if (okBtn) {
        okBtn.className = "btn " + (tone === "danger" ? "danger" : "primary");
      }

      const finish = (ok) => {
        if (Util._confirmResolve !== finish) return;
        Util._confirmResolve = null;
        modal.hidden = true;
        document.body.classList.remove("modal-open");
        document.removeEventListener("keydown", onKey, true);
        resolve(!!ok);
      };
      Util._confirmResolve = finish;

      function onKey(e) {
        if (modal.hidden) return;
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        } else if (e.key === "Enter" && document.activeElement !== cancelBtn) {
          e.preventDefault();
          finish(true);
        }
      }

      modal.onclick = (e) => {
        const t = e.target;
        if (!t) return;
        if (t === okBtn || (t.closest && t.closest("#confirm-modal-ok"))) {
          e.preventDefault();
          finish(true);
          return;
        }
        if (
          t === cancelBtn ||
          (t.closest && (t.closest("#confirm-modal-cancel") || t.closest("[data-confirm-dismiss]")))
        ) {
          e.preventDefault();
          finish(false);
        }
      };

      document.addEventListener("keydown", onKey, true);
      modal.hidden = false;
      document.body.classList.add("modal-open");
      window.setTimeout(() => {
        try { (okBtn || cancelBtn).focus(); } catch (_) {}
      }, 0);
    });
  };

  Util.setStatus = function (msg, kind, extra) {
    const el = document.getElementById("status-bar");
    if (!el) return;
    const right = extra ? `<span>${Util.escapeHtml(extra)}</span>` : "";
    el.innerHTML = `<span class="left ${kind || ""}">${Util.escapeHtml(msg)}</span><span class="right">${right}<span>${new Date().toLocaleTimeString()}</span></span>`;
  };

  /* Unified ACTION BANNER controller.
   *
   * One sticky bar combines what used to be three separate UI surfaces
   * (topbar Refresh button + Go-banner + progress banner). The phase
   * dictates what the button shows and whether the thin progress fill
   * is visible. setProgress / hideProgress / setActionPhase all drive
   * the same DOM element so callers can keep using the existing API.
   *
   *   setActionPhase("pending", text)  Go ▶ button, no fill bar
   *   setProgress(pct, text)           Loading… disabled button +
   *                                    progress fill at pct (or
   *                                    indeterminate when pct == null)
   *   hideProgress(text)               Fills to 100%, then transitions
   *                                    to "loaded" phase with text and
   *                                    the Refresh ↻ button.
   *
   * The banner stays visible after init — it's the primary action
   * surface for the page, not a transient toast. */
  /* @param opts.label / opts.icon  Override what the button says. The
   *        phase alone used to decide, which was fine while there was
   *        one thing the button could do. Now that it offers the
   *        narrowest useful scope — "Sync 4" when four subs are stale,
   *        "Refresh" when none are — the label is a property of the
   *        offer rather than of the lifecycle.
   * @param opts.action  Recorded on the button as data-refresh-action
   *        so the click handler runs whatever the label promised
   *        rather than re-deriving it and possibly disagreeing. */
  Util.setActionPhase = function (phase, message, opts) {
    const banner = document.getElementById("action-banner");
    if (!banner) return;
    banner.hidden = false;
    /* Phase classes drive button label/icon and progress fill
     * visibility via CSS. */
    banner.classList.remove("phase-pending", "phase-loading", "phase-loaded", "phase-empty");
    banner.classList.add("phase-" + phase);

    const text = document.getElementById("action-banner-text");
    if (text && message != null) text.textContent = message;

    const btn = document.getElementById("action-btn");
    const cancel = document.getElementById("action-cancel");
    const icon = btn && btn.querySelector(".action-btn-icon");
    const label = btn && btn.querySelector(".action-btn-label");
    const track = document.getElementById("action-progress-track");
    const timer = document.getElementById("action-progress-timer");
    if (track) track.hidden = phase !== "loading";
    if (timer) timer.hidden = phase !== "loading";
    if (cancel) {
      cancel.hidden = phase !== "loading";
      /* Every new Sync must rearm Cancel — otherwise a prior Force stop
       * label sticks around when the next run starts. */
      if (phase === "loading") {
        cancel.disabled = false;
        cancel.textContent = "Cancel";
        cancel.setAttribute("aria-label", "Cancel sync");
      }
    }
    if (btn) {
      btn.disabled = phase === "loading";
      banner.classList.toggle("is-loading", phase === "loading");
    }
    if (phase === "loading") {
      if (icon) icon.textContent = "⟳";
      if (label) label.textContent = "Loading…";
      if (btn) btn.setAttribute("aria-label", "Loading…");
      Util._ensureProgressTimer();
    } else if (phase === "loaded") {
      Util._stopProgressTimer();
      /* hideProgress lands here 600ms after a fetch finishes, with the
       * summary line but no opts — and it used to hand the button back
       * its generic "Refresh", which ran the full sweep. So every
       * scoped sync quietly rearmed the widest possible one. The offer
       * is Refresh's to decide, so ask it rather than guessing; the
       * caller's own opts still win when it has an opinion. */
      if (!opts || !opts.label) {
        const offer = typeof Util.actionOffer === "function" ? Util.actionOffer() : null;
        if (offer) opts = Object.assign({}, offer, opts);
      }
      const text = (opts && opts.label) || "Refresh";
      if (icon) icon.textContent = (opts && opts.icon) || "↻";
      if (label) label.textContent = text;
      if (btn) btn.setAttribute("aria-label", text === "Refresh" ? "Refresh data" : text);
    } else {
      Util._stopProgressTimer();
      /* pending or empty */
      if (icon) icon.textContent = (opts && opts.icon) || "▶";
      if (label) label.textContent = (opts && opts.label) || "Go";
      if (btn) btn.setAttribute("aria-label", "Run search");
    }
    if (btn) btn.dataset.refreshAction = (opts && opts.action) || (phase === "loaded" ? "new" : "go");
  };

  Util._formatElapsed = function (ms) {
    const sec = Math.max(0, Math.floor((ms || 0) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  };

  Util._ensureProgressTimer = function () {
    if (Util._progressStartedAt == null) Util._progressStartedAt = Date.now();
    const tick = () => {
      const el = document.getElementById("action-progress-timer");
      if (!el || Util._progressStartedAt == null) return;
      el.hidden = false;
      el.textContent = Util._formatElapsed(Date.now() - Util._progressStartedAt);
    };
    tick();
    if (Util._progressTimerIv) return;
    Util._progressTimerIv = setInterval(tick, 250);
  };

  Util._stopProgressTimer = function () {
    if (Util._progressTimerIv) {
      clearInterval(Util._progressTimerIv);
      Util._progressTimerIv = null;
    }
    Util._progressStartedAt = null;
    const el = document.getElementById("action-progress-timer");
    if (el) {
      el.hidden = true;
      el.textContent = "0:00";
    }
  };

  Util.setProgress = function (percent, message) {
    const banner = document.getElementById("action-banner");
    if (!banner) return;
    Util.setActionPhase("loading", message != null ? message : null);
    const fill = document.getElementById("action-progress-fill");
    if (percent == null) {
      banner.classList.add("indeterminate");
      if (fill) fill.style.width = "";
    } else {
      banner.classList.remove("indeterminate");
      if (fill) fill.style.width = Math.max(0, Math.min(100, percent)) + "%";
    }
    if (Util._progressHideT) {
      clearTimeout(Util._progressHideT);
      Util._progressHideT = null;
    }
  };

  Util.hideProgress = function (finalMessage) {
    const banner = document.getElementById("action-banner");
    if (!banner) return;
    banner.classList.remove("indeterminate");
    const fill = document.getElementById("action-progress-fill");
    if (fill) fill.style.width = "100%";
    /* Briefly leave the fill at 100% so the user sees the load
     * complete, then transition to the "loaded" phase which hides
     * the fill bar and switches the button to Refresh ↻. */
    if (Util._progressHideT) clearTimeout(Util._progressHideT);
    Util._progressHideT = setTimeout(() => {
      Util.setActionPhase("loaded", finalMessage || "Done");
      if (fill) fill.style.width = "0%";
      Util._progressHideT = null;
    }, finalMessage ? 600 : 300);
  };

  Util.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------
   * SHARE / SUBMIT DESTINATION
   * ------------------------------------------------------------------
   * Cross-posting via Reddit's /submit?url=… must carry the content's
   * real destination. Bare v.redd.it / i.redd.it hosts open as a dead
   * "Open" chip with no embed — the opposite of passing the content
   * through. We are deliberately NOT using Reddit's native xpost
   * (crosspost_parent) API: this builds an ordinary link (or self)
   * post that re-shares the underlying URL.
   * ------------------------------------------------------------------ */

  Util.isRedditCommentsUrl = function (raw) {
    return !!(raw && /reddit\.com\/(?:r\/[^/]+\/)?comments\//i.test(String(raw)));
  };

  Util.isRedditHostedMedia = function (raw) {
    if (!raw) return false;
    try {
      const u = new URL(String(raw), "https://www.reddit.com");
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (host === "v.redd.it" || host === "i.redd.it" || host === "preview.redd.it") return true;
      if (host === "reddit.com" || host.endsWith(".reddit.com")) {
        if (/^\/gallery\//i.test(u.pathname)) return true;
        if (/^\/video\//i.test(u.pathname)) return true;
        if (/^\/media\//i.test(u.pathname)) return true;
      }
      return false;
    } catch (_) {
      return /(?:^|\.)v\.redd\.it|(?:^|\.)i\.redd\.it|reddit\.com\/gallery\//i.test(String(raw));
    }
  };

  /* Unwrap Reddit's outbound click wrappers and common AMP shells without
   * a network round-trip — the destination is already in the query. */
  Util.unwrapShareUrl = function (raw) {
    if (!raw) return "";
    const s = String(raw).trim();
    if (!s) return "";
    try {
      const u = new URL(s, "https://www.reddit.com");
      const host = String(u.hostname || "").replace(/^www\./i, "").toLowerCase();
      const nested = u.searchParams.get("url") || u.searchParams.get("u") || "";

      /* outbound.reddit.com/?url=<dest>, /outgoing?url=, etc. */
      const isOutboundHost = host === "outbound.reddit.com" || host === "out.reddit.com";
      const isRedditHost = host === "reddit.com" || host.slice(-11) === ".reddit.com";
      if (nested && (isOutboundHost || (isRedditHost && (/outgoing/i.test(u.pathname) || u.searchParams.has("url"))))) {
        return Util.unwrapShareUrl(nested);
      }

      if ((host === "google.com") && nested && /^https?:/i.test(nested)) {
        return Util.unwrapShareUrl(nested);
      }

      if (host.indexOf("amp.") === 0) {
        const bare = host.slice(4);
        if (bare.indexOf(".") !== -1) {
          return Util.unwrapShareUrl(u.protocol + "//" + bare + u.pathname + u.search);
        }
      }
      return u.href;
    } catch (_) {
      return s;
    }
  };

  /* Pick the URL a cross-post submit should carry.
   *
   * Preference order:
   *   1. External (non-Reddit-media) destination on this post or its
   *      crosspost parent — the content itself.
   *   2. For Reddit-hosted video/image/gallery: the post permalink, so
   *      submit embeds the original player instead of a bare v.redd.it
   *      chip. Still a normal link post, not Reddit's xpost feature.
   *   3. Whatever url/permalink remains.
   *
   * Returns { url, kind: "link"|"self", note? }. */
  Util.shareDestination = function (post) {
    if (!post) return null;

    const candidates = [];
    function add(raw, why) {
      if (!raw) return;
      const unwrapped = Util.unwrapShareUrl(raw);
      if (!unwrapped) return;
      candidates.push({ raw: unwrapped, why: why || "" });
    }

    add(post.url_dest, "url_dest");
    add(post.url, "url");
    add(post.crosspost_parent_dest, "parent_dest");
    add(post.crosspost_parent_url, "parent_url");

    const external = candidates.find((c) => {
      if (Util.isRedditHostedMedia(c.raw)) return false;
      if (Util.isRedditCommentsUrl(c.raw)) return false;
      /* Self posts list their own comments URL as url — skip. */
      try {
        const host = new URL(c.raw).hostname.replace(/^www\./, "").toLowerCase();
        if (host === "reddit.com" || host.endsWith(".reddit.com")) return false;
      } catch (_) { return false; }
      return /^https?:\/\//i.test(c.raw);
    });
    if (external) {
      return { url: external.raw, kind: "link", source: external.why };
    }

    const redditMedia = post.is_video || post.is_gallery
      || Util.isRedditHostedMedia(post.url_dest || post.url)
      || Util.isRedditHostedMedia(post.crosspost_parent_dest || post.crosspost_parent_url);

    if (redditMedia) {
      /* Permalink carries the playable post; bare v.redd.it does not
       * embed when re-submitted as a fresh link post. */
      const permalink = post.permalink
        || (post.id ? ("https://www.reddit.com/comments/" + post.id) : "");
      if (permalink) {
        return {
          url: permalink,
          kind: "link",
          source: "permalink",
          note: "Reddit-hosted media — linking the original post so the player embeds",
        };
      }
    }

    if (post.is_self || (post.url && Util.isRedditCommentsUrl(post.url))) {
      return { url: "", kind: "self", source: "self" };
    }

    const fallback = (post.url_dest || post.url || post.permalink || "").trim();
    if (!fallback) return { url: "", kind: "self", source: "empty" };
    return {
      url: Util.unwrapShareUrl(fallback),
      kind: Util.isRedditCommentsUrl(fallback) && post.is_self ? "self" : "link",
      source: "fallback",
    };
  };

  /* Build a pre-filled Reddit compose URL for cross-posting into a
   * subreddit. Reddit's /submit page accepts:
   *   ?title=…
   *   ?selftext=true&text=…   for self/text posts (markdown supported)
   *   ?selftext=false&url=…   for link posts
   *
   * Body is capped at 30,000 chars by default to stay well within
   * practical URL-length limits on iOS Safari and other mobile
   * browsers. Callers that have done their own length budgeting (the
   * composer warns at 7000 and offers a "truncate to fit" button) can
   * raise the cap explicitly via `opts.maxBody`.
   *
   * Two call shapes:
   *
   *   1. Existing post object (used by the targeting recommender to
   *      offer a "share this post to r/X" link):
   *        Util.buildSubmitUrl("ProgressivePolitics", postFromReddit)
   *
   *   2. Composer draft (used by the markdown composer to bulk-emit
   *      submit URLs from a not-yet-posted draft):
   *        Util.buildSubmitUrl("ProgressivePolitics", {
   *          title: "…", body: "…", url: "…", isLinkPost: false
   *        }, { maxBody: 7500 })
   *
   * Returns a string URL or null if `sub` / `data` aren't usable. */
  Util.buildSubmitUrl = function (sub, data, opts) {
    if (!sub || !data) return null;
    const subName = String(sub).replace(/^\/?r\//i, "").trim();
    if (!subName) return null;
    opts = opts || {};
    const maxBody = Number.isFinite(opts.maxBody) ? opts.maxBody : 30000;
    const enc = encodeURIComponent;

    /* Composer-draft shape (object-form: { title, body, url, isLinkPost }).
     * Distinguished from a Reddit post object by the presence of `body`
     * or `isLinkPost` properties — Reddit posts use `selftext` and
     * `is_self`. We support both shapes for backward compat with the
     * targeting recommender, which feeds existing-post objects. */
    const isDraft =
      Object.prototype.hasOwnProperty.call(data, "body") ||
      Object.prototype.hasOwnProperty.call(data, "isLinkPost");

    let title, isSelf, text, linkUrl;
    if (isDraft) {
      title = String(data.title || "").slice(0, 300);
      isSelf = !data.isLinkPost;
      text = String(data.body || "");
      linkUrl = Util.unwrapShareUrl(String(data.url || ""));
    } else {
      title = String(data.title || "").slice(0, 300);
      const dest = Util.shareDestination(data);
      text = String(data.selftext || "");
      if (dest && dest.kind === "self") {
        isSelf = true;
        linkUrl = "";
        /* When the only shareable form is the original Reddit media
         * post, put its permalink in the body so the content still
         * travels with the title. */
        if (!text && data.permalink) {
          text = data.permalink;
        }
      } else {
        isSelf = false;
        linkUrl = dest && dest.url ? dest.url : "";
        /* Absolute last resort: never ship a bare v.redd.it chip. */
        if (linkUrl && Util.isRedditHostedMedia(linkUrl) && data.permalink) {
          linkUrl = data.permalink;
        }
      }
    }

    if (text.length > maxBody) text = text.slice(0, maxBody);

    const params = ["title=" + enc(title)];
    if (isSelf) {
      params.push("selftext=true");
      if (text) params.push("text=" + enc(text));
    } else if (linkUrl) {
      params.push("selftext=false");
      params.push("url=" + enc(linkUrl));
    } else {
      /* Draft with neither body nor URL — still render a self-post
       * skeleton so the user lands on the compose page with a title
       * filled in but the body empty for them to type fresh. */
      params.push("selftext=true");
    }
    return "https://www.reddit.com/r/" + enc(subName) + "/submit?" + params.join("&");
  };

  /* Detects Reddit mobile-share URLs of the form
   *   https://www.reddit.com/r/<sub>/s/<token>
   * where <token> is an opaque short code (NOT a post ID) that Reddit
   * 301-redirects to the canonical /comments/<id>/<title>/ URL. The token
   * length and case-mix differ from post IDs, so they need a separate
   * extractor and an async redirect-following step to resolve to a real ID.
   */
  const SHARE_RE = /(?:https?:\/\/)?(?:www\.|old\.|new\.)?reddit\.com\/r\/([A-Za-z0-9_]{2,30})\/s\/([A-Za-z0-9]{6,20})/gi;

  Util.SHARE_URL_RE = SHARE_RE;

  Util.isShareUrl = function (s) {
    if (!s) return false;
    SHARE_RE.lastIndex = 0;
    return SHARE_RE.test(String(s));
  };

  /* Like parseIdList but returns {ids, shares} so the caller can decide
   * whether to perform the (async) share-URL resolution step. parseIdList
   * remains unchanged for backwards compat. */
  Util.parsePostRefs = function (text) {
    if (!text) return { ids: [], shares: [] };
    const t = String(text);
    const shares = [];
    const seenShare = new Set();
    SHARE_RE.lastIndex = 0;
    let m;
    while ((m = SHARE_RE.exec(t)) !== null) {
      const sub = m[1];
      const token = m[2];
      const key = sub.toLowerCase() + "/" + token;
      if (seenShare.has(key)) continue;
      seenShare.add(key);
      const url = (m[0].startsWith("http") ? m[0] : "https://www.reddit.com/r/" + sub + "/s/" + token);
      shares.push({ url, sub: sub.toLowerCase(), token });
    }
    /* Strip share URLs out of the text so the downstream parseIdList
     * doesn't accidentally pick up the sub or token as a bare ID. */
    const stripped = t.replace(SHARE_RE, " ");
    const ids = Util.parseIdList(stripped);
    return { ids, shares };
  };

  /* Concurrency-limited parallel map. Spawns at most `n` workers and
   * resolves with an array aligned to `items` (errors caught into
   * { __error } objects so a single failure doesn't reject the batch). */
  Util.pmap = async function (items, n, fn, opts) {
    opts = opts || {};
    const results = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (true) {
        if (opts.stop && opts.stop()) return;
        const i = idx++;
        if (i >= items.length) return;
        try {
          results[i] = await fn(items[i], i);
        } catch (err) {
          results[i] = { __error: err };
        }
      }
    });
    await Promise.all(workers);
    return results;
  };

  /* Robust clipboard-write that survives iOS Safari's user-gesture
   * rule. Accepts either a string or a Promise<string>:
   *
   *   await Util.copyToClipboard("hello")              // sync text
   *   await Util.copyToClipboard(Sync.toShareUrl())    // async-computed text
   *
   * The async case is critical on iOS Safari. If a click handler
   * `await`s anything before calling navigator.clipboard.writeText,
   * the user-gesture context is gone and Safari throws
   *   NotAllowedError: The request is not allowed by the user agent
   *   or the platform in the current context, possibly because the
   *   user denied permission.
   *
   * The standard workaround is `navigator.clipboard.write` with a
   * `ClipboardItem` whose value is a *Promise* — Safari awaits the
   * promise inside the same gesture. We use that path whenever the
   * caller passed a thenable. Then we have two more fallbacks:
   *   - plain `clipboard.writeText` (for browsers without ClipboardItem)
   *   - hidden <textarea> + document.execCommand("copy") for ancient
   *     browsers / Safari edge cases that reject everything else.
   *
   * Returns true on success, false on every-fallback-exhausted.
   *
   * Lives on Util (not as a private helper in app.js) so any module
   * — composer, sync, campaign-detail, etc. — can share the same
   * battle-hardened implementation. The composer's AI prompt copy
   * was previously calling `Util.copyToClipboard` which didn't
   * exist; that silent typo always threw and surfaced as "Couldn't
   * copy — select & copy manually" in the UI.
   */
  /* Copy formatted text to the clipboard as BOTH text/html and
   * text/plain so the pasting app can pick whichever it
   * understands.
   *
   * Why this exists: Reddit's mobile app body editor is rich-text-
   * only — it doesn't parse markdown. A user composing in our
   * dashboard's markdown editor would tap "Open submit URL", land
   * in the Reddit app, paste their `**bold**` markdown, and watch
   * Reddit show the literal asterisks instead of rendering bold.
   *
   * Pasting HTML into Reddit's app editor (and most other rich-
   * text composers — Notes, Slack, Pages, Linear, etc.) is
   * converted to the app's native formatted output. Bold/italic/
   * lists/headings/quotes/links all carry through.
   *
   * `htmlOrPromise` and `plainOrPromise` may be strings or
   * thenables. The Promise variant matters on iOS Safari, which
   * loses the user-gesture context if we `await` before calling
   * `clipboard.write` — same issue copyToClipboard solves with
   * the ClipboardItem-with-Promise pattern.
   *
   * Returns true if something landed on the clipboard (HTML on
   * the rich path, plain on the fallback), false on failure. */
  Util.copyAsRichText = async function (htmlOrPromise, plainOrPromise) {
    const fallbackPlain = plainOrPromise == null ? htmlOrPromise : plainOrPromise;

    /* Path 1 — ClipboardItem-with-Promise carrying both MIME types.
     * iOS Safari 13.4+, Chrome 76+, Firefox 116+ all support
     * text/html through ClipboardItem; older runtimes refuse and
     * we fall through to the plain-text path. */
    if (typeof ClipboardItem !== "undefined"
        && navigator.clipboard && typeof navigator.clipboard.write === "function") {
      try {
        const htmlBlobPromise = Promise.resolve(htmlOrPromise)
          .then((h) => new Blob([String(h)], { type: "text/html" }));
        const textBlobPromise = Promise.resolve(fallbackPlain)
          .then((t) => new Blob([String(t)], { type: "text/plain" }));
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": htmlBlobPromise,
            "text/plain": textBlobPromise,
          }),
        ]);
        return true;
      } catch (_) {
        /* Fall through to plain-text path. Common reasons:
         *   - User-gesture lost (iOS) — but we used the Promise
         *     variant so this should be rare
         *   - Browser doesn't accept text/html via ClipboardItem
         *   - User denied clipboard permission */
      }
    }

    /* Path 2 — fall back to plain-text-only. The user pasting
     * into Reddit app gets the markdown source — uglier than
     * rich-text but readable. Pasting into a markdown-aware
     * editor (web/desktop Reddit, GitHub) renders correctly. */
    return Util.copyToClipboard(fallbackPlain);
  };

  Util.copyToClipboard = async function (textOrPromise) {
    const isPromise = textOrPromise && typeof textOrPromise.then === "function";

    /* Path 1 — ClipboardItem-with-Promise. Preserves iOS Safari's
     * user-gesture context across async work like CompressionStream
     * gzip. Supported macOS Safari 13.1+ / iOS Safari 13.4+ /
     * Chrome 76+ / Firefox 116+. */
    if (isPromise && typeof ClipboardItem !== "undefined"
        && navigator.clipboard && typeof navigator.clipboard.write === "function") {
      try {
        const blobPromise = Promise.resolve(textOrPromise)
          .then((t) => new Blob([String(t)], { type: "text/plain" }));
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blobPromise })]);
        return true;
      } catch (_) {
        /* Fall through. */
      }
    }

    let text;
    try { text = isPromise ? await textOrPromise : String(textOrPromise); }
    catch (_) { return false; }

    /* Path 2 — standard async writeText. */
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) { /* Fall through. */ }
    }

    /* Path 3 — hidden textarea + execCommand. Last-resort, but
     * surprisingly reliable on Safari when nothing else works. */
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.top = "0";
      ta.style.left = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (_) {
      return false;
    }
  };

  window.Util = Util;
})();
