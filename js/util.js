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
    if (!epochSeconds) return "—";
    const d = new Date(epochSeconds * 1000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return yyyy + "-" + mm + "-" + dd + " " + hh + ":" + mi;
  };

  Util.relTime = function (epochSeconds) {
    if (!epochSeconds) return "—";
    const diff = Date.now() / 1000 - epochSeconds;
    if (diff < 60) return Math.round(diff) + "s ago";
    if (diff < 3600) return Math.round(diff / 60) + "m ago";
    if (diff < 86400) return Math.round(diff / 3600) + "h ago";
    if (diff < 86400 * 30) return Math.round(diff / 86400) + "d ago";
    if (diff < 86400 * 365) return Math.round(diff / (86400 * 30)) + "mo ago";
    return Math.round(diff / (86400 * 365)) + "y ago";
  };

  /* Local-time clock string — "14:23" — for the Posts table's "When"
   * column. Pairs with relTime so the user sees both "2h ago" AND
   * the actual hour-of-day, which matters when assessing whether a
   * sub's "best hour" recommendation is genuine or just an artifact
   * of which posts happened to survive the front-page rotation long
   * enough to be in the snapshot. */
  Util.fmtClockTime = function (epochSeconds) {
    if (!epochSeconds) return "";
    const d = new Date(epochSeconds * 1000);
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
    if (!s || s === "[removed]" || s === "[deleted]") return "";
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
    const cap = limit == null ? 4000 : limit;
    return s.length > cap ? s.slice(0, cap) : s;
  };

  /* Everything about a post that carries its subject: the headline, the
   * framing the community applied, and the body. One accessor so that
   * "does this analysis read bodies?" has a single answer. */
  Util.postText = function (post, limit) {
    if (!post) return "";
    return [post.title || "", post.flair || "", Util.postBody(post, limit)]
      .filter(Boolean).join(" ");
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
    const icon = btn && btn.querySelector(".action-btn-icon");
    const label = btn && btn.querySelector(".action-btn-label");
    const track = document.getElementById("action-progress-track");
    if (track) track.hidden = phase !== "loading";
    if (btn) {
      btn.disabled = phase === "loading";
      banner.classList.toggle("is-loading", phase === "loading");
    }
    if (phase === "loading") {
      if (icon) icon.textContent = "⟳";
      if (label) label.textContent = "Loading…";
      if (btn) btn.setAttribute("aria-label", "Loading…");
    } else if (phase === "loaded") {
      const text = (opts && opts.label) || "Refresh";
      if (icon) icon.textContent = (opts && opts.icon) || "↻";
      if (label) label.textContent = text;
      if (btn) btn.setAttribute("aria-label", text === "Refresh" ? "Refresh data" : text);
    } else {
      /* pending or empty */
      if (icon) icon.textContent = (opts && opts.icon) || "▶";
      if (label) label.textContent = (opts && opts.label) || "Go";
      if (btn) btn.setAttribute("aria-label", "Run search");
    }
    if (btn) btn.dataset.refreshAction = (opts && opts.action) || (phase === "loaded" ? "all" : "go");
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
      linkUrl = String(data.url || "");
    } else {
      title = String(data.title || "").slice(0, 300);
      /* Treat the post as a self/text post if Reddit marked it so OR
       * if the link URL points back at the post itself (Reddit posts
       * a /comments/... permalink as `url` for self posts). */
      isSelf = !!(data.is_self || (data.url && /\/comments\//.test(data.url)));
      text = String(data.selftext || "");
      linkUrl = String(data.url || "");
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
  Util.pmap = async function (items, n, fn) {
    const results = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (true) {
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
