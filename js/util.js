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

  Util.fmtDateShort = function (epochSeconds) {
    if (!epochSeconds) return "—";
    const d = new Date(epochSeconds * 1000);
    return d.toISOString().slice(0, 16).replace("T", " ");
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

  Util.normalizeSubName = function (s) {
    if (!s) return "";
    return String(s).trim().replace(/^\/?r\//i, "").replace(/\/$/, "").toLowerCase();
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
          const cleaned = tok.replace(/^t3_/i, "").replace(/[^a-z0-9]/gi, "");
          if (/^[a-z0-9]{4,12}$/i.test(cleaned)) id = cleaned;
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

  window.Util = Util;
})();
