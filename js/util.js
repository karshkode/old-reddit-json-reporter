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

  Util.toast = function (msg, kind) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
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

  Util.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  window.Util = Util;
})();
