/* Reddit JSON fetcher.
 *
 * Reddit serves anonymous JSON over HTTPS at:
 *   https://www.reddit.com/r/<sub>/<listing>.json
 *   https://www.reddit.com/comments/<id>.json
 *   https://www.reddit.com/by_id/t3_<id>.json
 *
 * However, Reddit's response does NOT include `Access-Control-Allow-Origin`
 * headers, so a browser running on https://*.github.io cannot fetch these
 * URLs directly. Reddit also actively returns a 403 "Blocked" HTML page to
 * datacenter and unidentified IPs.
 *
 * To make this static site work from GitHub Pages we route requests through
 * a chain of public CORS proxies, validate that the response is real Reddit
 * JSON (the proxy may forward Reddit's HTML "Blocked" page, which we must
 * reject so the next proxy is tried), and cache successful responses.
 *
 * Users can override the proxy via the "Data source" select in the topbar
 * or by calling Reddit.setTransport(name).
 */
(function () {
  const Reddit = {};

  const BASE = "https://www.reddit.com";
  const CACHE_TTL_MS = 5 * 60 * 1000;
  /* Stale-while-revalidate window (PR 7). When a cached response is
   * older than CACHE_TTL_MS but younger than CACHE_SWR_MAX_MS, we
   * RETURN it immediately AND fire a background fetch to refresh the
   * cache for next time. Big perceived-speed win for the campaign
   * Watch mode + repeat dashboard refreshes. */
  const CACHE_SWR_MAX_MS = 30 * 60 * 1000;
  const memCache = new Map();
  const inflight = new Map();
  const STORAGE_KEY = "rj.transport";
  /* User-configured custom proxy URL (e.g. their own Cloudflare Worker).
   * See cloudflare-worker/SETUP.md for deployment instructions. The
   * dashboard appends ?url=<encoded-reddit-url> automatically; the
   * `customBuild` helper below is permissive about exactly how the
   * URL is shaped (with or without trailing `?` / `&` / `?url=`). */
  const CUSTOM_PROXY_KEY = "rj.customProxy";

  function getCustomProxyUrl() {
    try {
      const raw = localStorage.getItem(CUSTOM_PROXY_KEY) || "";
      const normalized = normalizeCustomProxyUrl(raw);
      /* One-time auto-heal: if the stored value isn't already
       * canonical (trailing slash, extra whitespace, etc.), rewrite
       * it. This rescues users who pasted before the
       * normalization fix shipped — without this, their old
       * entry keeps producing broken `/?url=` URLs forever. */
      if (raw !== normalized) {
        try { localStorage.setItem(CUSTOM_PROXY_KEY, normalized); } catch (_) {}
      }
      return normalized;
    } catch (_) { return ""; }
  }
  function setCustomProxyUrl(url) {
    try {
      const v = normalizeCustomProxyUrl(url);
      if (v) localStorage.setItem(CUSTOM_PROXY_KEY, v);
      else localStorage.removeItem(CUSTOM_PROXY_KEY);
    } catch (_) {}
  }
  /* Normalize a user-pasted proxy URL.
   *
   * Why: users routinely paste with a trailing slash
   * (`https://x.workers.dev/`). For a Cloudflare Worker, that slash
   * is meaningless — the worker has no /path routing. But the OLD
   * customBuild used `endsWith("/")` as a signal that the user
   * wanted CODETABS-STYLE PATH-BASED proxying:
   *
   *   "https://x.workers.dev/" + "https://www.reddit.com/…"
   *   -> "https://x.workers.dev/https://www.reddit.com/…"
   *
   * Our worker reads its target from ?url=, not from the path, so
   * it would reject every such request with
   *   {"error":400,"message":"Missing ?url= parameter."}
   *
   * Fix: strip a trailing slash when the URL is bare-host (no
   * other path component, no query). That preserves explicit path
   * proxies like `https://my.com/proxy/` while disambiguating the
   * common Cloudflare Worker paste case.
   */
  function normalizeCustomProxyUrl(url) {
    let v = String(url || "").trim();
    if (!v) return "";
    try {
      const parsed = new URL(v);
      /* Bare host: pathname is "/" and no search params. */
      if (parsed.pathname === "/" && !parsed.search) {
        v = parsed.protocol + "//" + parsed.host;
      }
    } catch (_) { /* malformed input — leave as-is, customBuild will fail loudly */ }
    return v;
  }
  Reddit.getCustomProxyUrl = getCustomProxyUrl;
  Reddit.setCustomProxyUrl = setCustomProxyUrl;

  /* Build the per-request URL for a custom proxy. Tolerates three
   * common shapes the user might paste:
   *   1. Bare Cloudflare Worker URL          ->  appends `?url=<enc>`
   *      e.g. https://reddit-proxy.alex.workers.dev
   *   2. Worker with trailing query stub     ->  appends `<enc>`
   *      e.g. https://reddit-proxy.alex.workers.dev/?url=
   *   3. codetabs-style path proxy           ->  appends `<full url>`
   *      e.g. https://my-proxy.example.com/proxy/
   */
  function customBuild(reddit) {
    const base = getCustomProxyUrl();
    if (!base) return null;
    /* 1. Explicit `?url=` / `?` / `&` stub — caller has pre-shaped
     *    the proxy URL; we just append the encoded target. */
    if (/[\?&]url=$/i.test(base) || base.endsWith("?") || base.endsWith("&")) {
      return base + encodeURIComponent(reddit);
    }
    /* 2. Codetabs-style path-based proxy — caller put `/proxy/` in
     *    the path. We append the FULL Reddit URL with no encoding. */
    if (/\/proxy\/?$/i.test(base)) {
      return base.replace(/\/?$/, "/") + reddit;
    }
    /* 3. Already has a query — append as another param. */
    if (base.includes("?")) {
      return base + "&url=" + encodeURIComponent(reddit);
    }
    /* 4. DEFAULT: append `/?url=…`. This is the right shape for a
     *    Cloudflare Worker. We strip any trailing slash on the
     *    base first (setCustomProxyUrl normalizes already, but
     *    this is belt-and-suspenders for share-link payloads that
     *    might have escaped normalization). */
    return base.replace(/\/+$/, "") + "/?url=" + encodeURIComponent(reddit);
  }

  /* A "transport" wraps a Reddit URL into a CORS-friendly request.
   * Each transport's `build(redditUrl)` returns the URL the browser hits.
   *
   * `direct` only works if the user has installed a CORS-disabling browser
   * extension or if a future Reddit policy change adds CORS support; we
   * keep it as a manual option but never auto-pick it.
   */
  const TRANSPORTS = [
    { name: "auto", label: "Auto (try archive + custom proxy + public proxies)" },
    /* Not a proxy at all: a different data source, called straight from
     * the browser because it sends CORS headers. It answers when every
     * proxy is blocked, which since Reddit's datacenter-IP ban is most
     * of the time. `fetchDirect` replaces build()+parse() wholesale
     * because the archive speaks its own API and the adapter has to
     * translate both the request and the response. */
    {
      name: "archive",
      label: "Reddit archive (no proxy needed)",
      fetchDirect: (redditUrl, signal) => Archive.fetchRedditUrl(redditUrl, { signal: signal }),
    },
    { name: "custom", label: "Custom (your CORS proxy)", build: customBuild },
    { name: "codetabs", label: "codetabs.com proxy", build: (u) => "https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent(u) },
    { name: "allorigins", label: "allorigins.win proxy", build: (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u) },
    { name: "corsproxy", label: "corsproxy.io proxy", build: (u) => "https://corsproxy.io/?" + encodeURIComponent(u) },
    { name: "isomorphic", label: "isomorphic-git/cors-proxy", build: (u) => "https://cors.isomorphic-git.org/" + u.replace(/^https?:\/\//, "") },
    { name: "direct", label: "Direct (needs CORS unblocker)", build: (u) => u },
  ];
  Reddit.TRANSPORTS = TRANSPORTS;

  /* Auto-rotation order. The archive leads because it is the only
   * source that currently answers at all: Reddit 403s every datacenter
   * IP, which is what all the proxies below are. They stay in the chain
   * because a proxy that does get through returns live scores, which the
   * archive cannot, so it is worth spending a few seconds finding out.
   * `isomorphic` (cors.isomorphic-git.org) is left out because its
   * deployment is effectively dead. */
  const AUTO_ORDER_BASE = ["archive", "codetabs", "allorigins", "corsproxy"];

  function isUsable(t) {
    return !!(t && (t.build || t.fetchDirect));
  }

  let preferredTransport = "auto";
  try { preferredTransport = localStorage.getItem(STORAGE_KEY) || "auto"; } catch (_) {}

  Reddit.getTransport = () => preferredTransport;
  Reddit.setTransport = function (name) {
    preferredTransport = name;
    try { localStorage.setItem(STORAGE_KEY, name); } catch (_) {}
  };

  Reddit.clearCache = function () {
    memCache.clear();
    try {
      for (const k of Object.keys(sessionStorage)) {
        if (k.startsWith("rj:")) sessionStorage.removeItem(k);
      }
    } catch (_) {}
  };

  /* Returns { v, fresh, stale } where:
   *   fresh = entry is younger than CACHE_TTL_MS (use directly)
   *   stale = entry is older than TTL but younger than SWR_MAX
   *           (return immediately + caller should kick off a
   *            background revalidate)
   *   neither -> null (treat as cache miss) */
  function cacheGet(key) {
    function evaluate(entry) {
      if (!entry) return null;
      const age = Date.now() - entry.t;
      if (age < CACHE_TTL_MS) return { v: entry.v, fresh: true, stale: false, age };
      if (age < CACHE_SWR_MAX_MS) return { v: entry.v, fresh: false, stale: true, age };
      return null;
    }
    const mem = evaluate(memCache.get(key));
    if (mem) return mem;
    try {
      const raw = sessionStorage.getItem("rj:" + key);
      if (raw) {
        const parsed = JSON.parse(raw);
        const r = evaluate(parsed);
        if (r) { memCache.set(key, parsed); return r; }
      }
    } catch (_) {}
    return null;
  }

  function cacheSet(key, value) {
    const entry = { t: Date.now(), v: value };
    memCache.set(key, entry);
    try {
      sessionStorage.setItem("rj:" + key, JSON.stringify(entry));
    } catch (_) {}
  }

  function getTransportByName(name) {
    return TRANSPORTS.find((t) => t.name === name);
  }

  function transportsToTry() {
    if (preferredTransport === "auto") {
      const order = AUTO_ORDER_BASE.slice();
      /* If the user has configured their own proxy (typically a
       * Cloudflare Worker), put it FIRST. It's the most reliable
       * link in the chain since the user controls the upstream IP. */
      if (getCustomProxyUrl()) order.unshift("custom");
      /* Bubble the most recently successful transport to the front so a
       * slow/dead proxy isn't tried first on every subsequent request.
       * The custom proxy already starts at the front so this only
       * shuffles the public ones. */
      const last = Reddit._lastTransport;
      if (last && order.includes(last) && last !== "custom") {
        const i = order.indexOf(last);
        if (i > 1) {  /* skip index 0 if it's the custom proxy */
          const [t] = order.splice(i, 1);
          /* Insert AFTER custom (if present) so custom stays first. */
          order.splice(getCustomProxyUrl() ? 1 : 0, 0, t);
        }
      }
      return order.map(getTransportByName).filter(isUsable);
    }
    const t = getTransportByName(preferredTransport);
    /* If the user picked "custom" but hasn't configured a URL yet, fall
     * back to auto — better than throwing on every fetch. */
    if (preferredTransport === "custom" && !getCustomProxyUrl()) {
      return AUTO_ORDER_BASE.map(getTransportByName).filter(isUsable);
    }
    return isUsable(t) ? [t] : AUTO_ORDER_BASE.map(getTransportByName).filter(isUsable);
  }

  function looksLikeBlockedHtml(text) {
    if (!text) return false;
    const head = text.slice(0, 600).toLowerCase();
    if (head.startsWith("<")) return true;
    if (head.includes("whoa there, pardner")) return true;
    if (head.includes("<title>blocked")) return true;
    if (head.includes("blocked due to a network policy")) return true;
    return false;
  }

  /* Normalize browser-specific fetch failure messages into a single
   * plain-language label. Without this, users see Safari's
   * "TypeError: Load failed" or Chrome's "Failed to fetch" or
   * Firefox's "NetworkError when attempting to fetch resource" and
   * can't tell whether it's a parsing problem, a CORS reject, or
   * a dead proxy. The actual root cause is identical for all three:
   * the browser refused or couldn't complete the network request. */
  function normalizeFetchKind(e) {
    if (!e) return "fetch failed";
    if (e.name === "AbortError") return "timeout";
    const m = String(e.message || e || "").trim();
    if (m === "Load failed" || m === "Failed to fetch" || /networkerror/i.test(m)) {
      return "network/CORS rejected";
    }
    return m || "fetch failed";
  }

  /* Throw an Error tagged with .transport, .kind, .attempt so
   * fetchJson() can build a per-transport summary at the end of
   * the chain. Without these tags we'd be string-parsing the
   * messages downstream — fragile. */
  function throwTransportError(transport, kind, attempt) {
    const err = new Error(kind + " via " + transport.name);
    err.transport = transport.name;
    err.kind = kind;
    err.attempt = attempt;
    return err;
  }

  async function tryTransport(transport, redditUrl, attempt) {
    /* Direct-fetch transports (the archive) own the whole exchange:
     * they translate the request, call their own API and hand back
     * Reddit-shaped JSON, so none of the proxy response-sniffing below
     * applies to them. */
    if (transport.fetchDirect) {
      const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
      const tid = controller ? setTimeout(() => controller.abort(), 8000) : null;
      try {
        const data = await transport.fetchDirect(redditUrl, controller && controller.signal);
        return { data, transport: transport.name };
      } catch (e) {
        /* "This source cannot answer this question" is a routing fact,
         * not an outage. Tag it so the caller can skip the retry pass
         * and so it does not pollute the transport health stats. */
        if (window.Archive && Archive.isUnsupported(e)) {
          const err = throwTransportError(transport, e.message, attempt);
          err.archiveUnsupported = true;
          throw err;
        }
        throw throwTransportError(transport, normalizeFetchKind(e), attempt);
      } finally {
        if (tid) clearTimeout(tid);
      }
    }

    const target = transport.build(redditUrl);
    /* customBuild returns null when the user picked Custom but
     * hasn't pasted a URL yet. Fail fast with a helpful message
     * instead of attempting fetch(null). */
    if (!target) {
      throw throwTransportError(transport, "no proxy URL configured", attempt);
    }
    /* 8s hard timeout per proxy attempt — without this a slow proxy can
     * block the entire fallback chain. AbortController is widely supported
     * including iOS Safari 12.1+. */
    const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    /* 5s hard timeout per proxy attempt — was 8s, but with 3 proxies
     * × 2 attempts × N subs × M campaign IDs that compounds into
     * minutes of waiting when proxies are flat dead. 5s is still
     * generous for any healthy proxy. */
    const tid = controller ? setTimeout(() => controller.abort(), 5000) : null;
    let res;
    try {
      res = await fetch(target, {
        method: "GET",
        credentials: "omit",
        headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.5" },
        signal: controller && controller.signal,
      });
    } catch (e) {
      throw throwTransportError(transport, normalizeFetchKind(e), attempt);
    } finally {
      if (tid) clearTimeout(tid);
    }
    if (res.status === 429) {
      const retry = parseInt(res.headers.get("Retry-After") || "0", 10);
      await Util.sleep(Math.max(800 * Math.pow(2, attempt), retry * 1000));
      /* Phrase 429s differently for the user's own proxy vs a public
       * one — actionable advice is different ("wait and retry" vs
       * "Reddit is rate-limiting your Cloudflare Worker — wait
       * 30-60s, the worker's edge cache will mostly absorb future
       * refreshes once it warms up"). */
      const phrase = transport.name === "custom"
        ? "Reddit rate-limited your worker (429) — wait 30-60s, then retry"
        : "rate limited (429)";
      throw throwTransportError(transport, phrase, attempt);
    }
    if (!res.ok) {
      /* Worker v2.0 surfaces Reddit block-pages as 503 with a
       * structured JSON body. Try to extract the human-readable
       * `message` so the dashboard error matches the worker's
       * diagnosis exactly. */
      let detail = "";
      if (res.status === 503 && transport.name === "custom") {
        try {
          const body = await res.clone().json();
          if (body && body.message) {
            detail = ": " + String(body.message).slice(0, 120);
          }
        } catch (_) {}
      }
      throw throwTransportError(transport, "HTTP " + res.status + detail, attempt);
    }
    const text = await res.text();
    /* Empty 200 — codetabs sometimes returns 200 with a 0-byte body
     * when its upstream fetch succeeded but produced nothing. Old
     * code threw "non-JSON response via codetabs" via JSON.parse,
     * which is technically right but unhelpfully vague. Be explicit. */
    if (!text || !text.trim()) {
      throw throwTransportError(transport, "empty response (proxy returned " + res.status + " with no body)", attempt);
    }
    if (looksLikeBlockedHtml(text)) {
      throw throwTransportError(transport, "Reddit blocked page", attempt);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw throwTransportError(transport, "non-JSON response", attempt);
    }
    /* Reject "proxy error" JSON shapes — corsproxy.io now returns
     *   {"error":"Server-side requests are not allowed on your plan…"}
     * which our old check accepted because `error` was a string, not
     * the Reddit numeric error code. Reddit error responses are shaped
     *   {"error": 403, "message": "Forbidden"}
     * and never carry both `error` AND `data`/`kind`. */
    if (data && typeof data === "object" && !Array.isArray(data) && data.error != null) {
      const isRedditError = typeof data.error === "number" && data.error >= 400;
      const isProxyJunk = !data.data && !data.kind;
      if (isRedditError) {
        /* Distinguish Reddit-side errors (forwarded by the proxy
         * intact) from proxy-side errors. Reddit returning 500 means
         * Reddit is having a bad day; the user can't fix that by
         * switching proxies. The error code in the message helps
         * the circuit breaker / UI banner explain the situation. */
        const code = data.error;
        const tag = (code >= 500) ? `Reddit ${code} (server error)`
                  : (code === 429) ? "Reddit 429 (rate limited)"
                  : `Reddit ${code}`;
        throw throwTransportError(transport, tag + (data.message ? ": " + data.message : ""), attempt);
      }
      if (isProxyJunk) {
        const msg = typeof data.error === "string" ? data.error.slice(0, 80) : "error " + data.error;
        throw throwTransportError(transport, "proxy error: " + msg, attempt);
      }
    }
    return { data, transport: transport.name };
  }

  /* Per-proxy success/failure tally so the UI can render a small
   * health dashboard ("codetabs ✓ 100% · allorigins ⚠ 60% blocked").
   * Recent-window EMA — gives more weight to recent attempts so a
   * proxy that just came back online doesn't stay flagged forever.
   * (PR 2 — already in main.) */
  Reddit._stats = { byTransport: {} };

  /* Circuit breaker — once we've had N consecutive "all proxies
   * failed" rejections, fast-fail subsequent fetchJson calls
   * without spending 30+ seconds re-trying every dead proxy. The
   * breaker re-arms automatically after a cool-off so transient
   * outages don't permanently block the user — they can also tap
   * Refresh to force a re-probe via clearCircuitBreaker(). */
  const CIRCUIT_BREAKER_THRESHOLD = 3;       // consecutive total failures
  const CIRCUIT_BREAKER_COOL_MS   = 60000;   // 1 min before re-probe
  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;
  function tripCircuitBreaker(summaryError) {
    consecutiveFailures++;
    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOL_MS;
      consecutiveFailures = 0;
      Reddit._lastCircuitTripError = summaryError;
      console.warn("[reddit] circuit breaker OPEN — all proxies failing; pausing fetches for", CIRCUIT_BREAKER_COOL_MS / 1000, "s");
    }
  }
  function resetCircuitBreaker() {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
  }
  Reddit.clearCircuitBreaker = resetCircuitBreaker;
  function isCircuitOpen() {
    return circuitOpenUntil > Date.now();
  }
  function recordTransportOutcome(transportName, ok, kind) {
    if (!transportName) return;
    const s = Reddit._stats.byTransport[transportName] = Reddit._stats.byTransport[transportName] || { ok: 0, fail: 0, lastKind: null, recent: [] };
    s.ok += ok ? 1 : 0;
    s.fail += ok ? 0 : 1;
    if (!ok && kind) s.lastKind = kind;
    s.recent.push(ok ? 1 : 0);
    if (s.recent.length > 20) s.recent.shift();
    if (typeof Reddit.onTransportStats === "function") {
      try { Reddit.onTransportStats(Reddit._stats.byTransport); } catch (_) {}
    }
  }

  /* Fire-and-forget revalidation for SWR (PR 7). Updates the cache
   * for the next caller; never throws (errors are logged). */
  function revalidateInBackground(redditUrl, key) {
    const promise = (async () => {
      const transports = transportsToTry();
      for (const t of transports) {
        try {
          const out = await tryTransport(t, redditUrl, 0);
          cacheSet(key, out.data);
          Reddit._lastTransport = out.transport;
          if (typeof Reddit.onTransportSuccess === "function") Reddit.onTransportSuccess(out.transport);
          return;
        } catch (_) { /* keep trying */ }
      }
    })().finally(() => { inflight.delete(key); });
    inflight.set(key, promise);
  }

  async function fetchJson(path, params) {
    const url = new URL(BASE + path);
    url.searchParams.set("raw_json", "1");
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== "") url.searchParams.set(k, v);
      }
    }
    const redditUrl = url.toString();
    const key = url.pathname + "?" + url.searchParams.toString();
    const cached = cacheGet(key);
    if (cached && cached.fresh) return cached.v;
    /* Stale-while-revalidate: return stale data immediately, but
     * kick off a background revalidate so the next call gets fresh
     * data without waiting. */
    if (cached && cached.stale && !inflight.has(key)) {
      revalidateInBackground(redditUrl, key);
      return cached.v;
    }
    if (inflight.has(key)) return inflight.get(key);

    /* Circuit breaker: if every proxy has failed N times in a row
     * recently, fast-fail without waiting another 15+ seconds for
     * each new request to time out individually. The user can tap
     * Refresh to force re-probe. */
    if (isCircuitOpen()) {
      const last = Reddit._lastCircuitTripError || "all proxies failing";
      const secsLeft = Math.ceil((circuitOpenUntil - Date.now()) / 1000);
      const err = new Error(`fast-fail: ${last} (auto-retry in ${secsLeft}s — or tap Refresh)`);
      err.circuit = true;
      throw err;
    }

    const promise = (async () => {
      const transports = transportsToTry();
      /* Per-transport latest failure. The map is keyed by transport
       * name; later attempts overwrite the kind for the same name so
       * we end up with one row per *transport* (not one per attempt),
       * deduplicated for display. */
      const lastByTransport = new Map();
      let anySuccessThisCall = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const t of transports) {
          try {
            const out = await tryTransport(t, redditUrl, attempt);
            cacheSet(key, out.data);
            Reddit._lastTransport = out.transport;
            recordTransportOutcome(out.transport, true);
            anySuccessThisCall = true;
            /* A successful call resets the circuit breaker — proxies
             * are alive again. */
            resetCircuitBreaker();
            if (typeof Reddit.onTransportSuccess === "function") Reddit.onTransportSuccess(out.transport);
            return out.data;
          } catch (err) {
            const tName = (err && err.transport) || (t && t.name) || "?";
            const kind = (err && err.kind) || (err && err.message) || String(err);
            lastByTransport.set(tName, kind);
            /* A source declining to answer a question it structurally
             * cannot answer is not a health signal — counting it would
             * make the archive look broken every time discovery asks
             * for a site-wide search. */
            if (!err || !err.archiveUnsupported) recordTransportOutcome(tName, false, kind);
          }
        }
        await Util.sleep(250 * Math.pow(2, attempt));
      }

      /* Build a rich summary error so the UI doesn't show one
       * arbitrary "via X" message that hides the real picture.
       *
       * If every transport failed with the SAME kind (e.g. all
       * timed out), simplify to "all N proxies — <kind>".
       * Otherwise list each transport(kind) so the user sees
       * exactly what each proxy did. */
      const entries = Array.from(lastByTransport.entries());
      let summary;
      const kinds = new Set(entries.map(([, k]) => k));
      if (entries.length === 0) {
        summary = "all proxies failed";
      } else if (kinds.size === 1) {
        summary = `all ${entries.length} prox${entries.length === 1 ? "y" : "ies"} ${entries[0][1]}`;
      } else {
        summary = `all ${entries.length} proxies failed — ${entries.map(([t, k]) => `${t}(${k})`).join(" · ")}`;
      }
      const err = new Error(summary);
      err.attempts = entries.map(([t, k]) => ({ transport: t, kind: k }));
      /* Trip the breaker so subsequent calls fast-fail.
       *
       * EXCEPT when the only transport that was tried is the user's
       * own custom proxy. The breaker exists to save the user from
       * sitting through 30+ seconds of public-proxy timeouts when
       * everything's down — but a custom proxy responds in well
       * under a second whether it's healthy or not. Tripping the
       * breaker on custom-only failures just means the user gets
       * "fast-fail: …" for 60 seconds every time their personal
       * worker hiccups once, which is worse than just letting them
       * tap Refresh and find out immediately. */
      const onlyCustom = entries.length === 1 && entries[0][0] === "custom";
      if (!onlyCustom) {
        tripCircuitBreaker(summary);
      } else {
        console.warn("[reddit] custom-only transport failed (" + summary + ") — NOT tripping circuit breaker");
      }
      throw err;
    })();
    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(key);
    }
  }

  Reddit.fetchJson = fetchJson;

  /* Fetch a listing for a subreddit, paginating with `after` until
   * the requested limit is reached or no more pages. */
  Reddit.fetchSubredditListing = async function (subreddit, opts) {
    opts = opts || {};
    const sub = Util.normalizeSubName(subreddit);
    const listing = opts.listing || "hot";
    const time = opts.t || "week";
    const target = Math.max(1, Math.min(opts.limit || 100, 1000));
    const out = [];
    let after = null;
    const pageSize = Math.min(100, target);
    while (out.length < target) {
      const params = { limit: pageSize, t: time };
      if (after) params.after = after;
      const json = await fetchJson(`/r/${sub}/${listing}.json`, params);
      const children = (json && json.data && json.data.children) || [];
      if (!children.length) break;
      const newOnThisPage = [];
      for (const c of children) {
        if (c && c.kind === "t3" && c.data) {
          const post = normalizePost(c.data);
          out.push(post);
          newOnThisPage.push(post);
        }
        if (out.length >= target) break;
      }
      /* Fire opts.onPage(posts) so callers can stream UI updates as
       * each page lands instead of waiting for the whole sub to
       * paginate. Used by the progress bar to stay in step with the
       * actual post count, not just the sub-completion count. */
      if (newOnThisPage.length && typeof opts.onPage === "function") {
        try { opts.onPage(newOnThisPage); } catch (_) {}
      }
      after = json && json.data && json.data.after;
      if (!after) break;
    }
    return out;
  };

  /* Fetch a single post by ID. Returns { post, comments[] }. */
  Reddit.fetchPostWithComments = async function (postId, opts) {
    opts = opts || {};
    const id = String(postId).replace(/^t3_/, "");
    const json = await fetchJson(`/comments/${id}.json`, {
      limit: opts.commentLimit || 50,
      sort: opts.sort || "top",
    });
    if (!Array.isArray(json) || json.length < 2) return null;
    const postData = json[0].data && json[0].data.children && json[0].data.children[0] && json[0].data.children[0].data;
    if (!postData) return null;
    const comments = [];
    const stack = (json[1].data && json[1].data.children) || [];
    for (const c of stack) {
      if (c.kind === "t1" && c.data) {
        comments.push({
          id: c.data.id,
          author: c.data.author,
          body: c.data.body,
          score: c.data.score,
          created_utc: c.data.created_utc,
          replies: countReplies(c.data.replies),
        });
      }
    }
    return { post: normalizePost(postData), comments };
  };

  /* Bulk fetch lightweight post info by IDs using the by_id endpoint.
   * Reddit allows up to 100 IDs per call.
   */
  Reddit.fetchPostsByIds = async function (ids, opts) {
    opts = opts || {};
    const cleaned = Util.uniqBy(
      (ids || []).map((id) => String(id).replace(/^t3_/, "").trim()).filter(Boolean),
      (x) => x
    );
    if (!cleaned.length) return [];

    /* Track the most recent transport-level failure so callers
     * (Campaigns.fetchAggregated -> renderCampaignDetail) can surface
     * a meaningful error instead of just listing un-resolved IDs.
     * Attached to the returned array as a non-enumerable property
     * so existing array consumers keep working. */
    let lastError = null;

    /* Preferred path: batch via /by_id (one request per up-to-100 IDs). */
    try {
      const results = [];
      for (let i = 0; i < cleaned.length; i += 100) {
        const batch = cleaned.slice(i, i + 100).map((id) => "t3_" + id);
        const json = await fetchJson(`/by_id/${batch.join(",")}.json`, {});
        const children = (json && json.data && json.data.children) || [];
        for (const c of children) {
          if (c && c.kind === "t3" && c.data) results.push(normalizePost(c.data));
        }
      }
      return results;
    } catch (batchErr) {
      lastError = batchErr;
      console.warn("[fetchPostsByIds] /by_id batch failed, falling back to per-ID /comments:", batchErr && batchErr.message);
    }

    /* Fallback: fetch each ID individually via /comments/<id>.json with
     * concurrency 3. The proxy may have rate-limited the batch URL but
     * cached or service individual lookups. We accept partial success —
     * any IDs that still fail simply aren't included. */
    const results = [];
    await Util.pmap(cleaned, 3, async (id) => {
      try {
        const json = await fetchJson(`/comments/${id}.json`, { limit: 1 });
        const postData = Array.isArray(json) && json[0] && json[0].data && json[0].data.children && json[0].data.children[0] && json[0].data.children[0].data;
        if (postData) results.push(normalizePost(postData));
      } catch (e) {
        lastError = e;
        console.warn("[fetchPostsByIds] /comments/" + id + " failed:", e && e.message);
      }
    });
    /* Stash the last error if everything failed so the caller can
     * surface it. Successful runs leave the property undefined. */
    if (results.length === 0 && lastError) {
      Object.defineProperty(results, "_lastError", { value: lastError, enumerable: false });
    }
    return results;
  };

  function countReplies(replies) {
    if (!replies || !replies.data || !replies.data.children) return 0;
    let n = 0;
    for (const c of replies.data.children) {
      if (c.kind === "t1") n += 1 + countReplies(c.data && c.data.replies);
    }
    return n;
  }

  function normalizePost(d) {
    /* Embedded-media metadata.
     *
     * For posts that LINK to external video/article sources (YouTube,
     * Vimeo, news sites, Twitter, etc.), Reddit returns oEmbed data
     * inside `data.media.oembed` — this is the ACTUAL title of the
     * linked resource, often far more descriptive than the post's
     * own title (e.g. a Reddit post "Watch this!" linking to a
     * 10-minute video titled "Senator Sanders speaks on healthcare
     * policy").  `secure_media_embed` is the encrypted-iframe variant
     * Reddit uses for the same content. Reddit-native videos populate
     * `data.media.reddit_video` instead (no oembed.title).
     *
     * If neither oEmbed source has a title (Reddit-native videos,
     * direct image links, self-text posts) these stay null and the
     * UI falls back to the post's own title. */
    const m = d.media || {};
    const oe = (m && m.oembed) || {};
    const sm = d.secure_media_embed || {};
    /* Reddit-native data-quality flags. These distort score-based
     * analytics (mod-pinned posts get artificial boost; removed posts
     * have no real engagement) so downstream UI can call them out and
     * the median/percentile math can exclude them. */
    const removedReason = d.removed_by_category || null;
    const isRemoved = !!(d.removed || (d.selftext === "[removed]") || (d.author === "[deleted]") || removedReason);
    const isModPinned = !!(d.stickied || d.pinned);
    const isLocked = !!d.locked;
    const isOver18 = !!d.over_18;
    const isSpoiler = !!d.spoiler;
    /* Reddit-native crosspost (a post that REPOSTS another post via
     * Reddit's /submit-crosspost UI). The parent's full data is in
     * crosspost_parent_list[0] when present. */
    const xpParentList = Array.isArray(d.crosspost_parent_list) ? d.crosspost_parent_list : [];
    const xpParent = xpParentList[0] || null;
    return {
      id: d.id,
      fullname: d.name,
      subreddit: d.subreddit,
      subreddit_prefixed: d.subreddit_name_prefixed,
      title: d.title,
      author: d.author,
      created_utc: d.created_utc,
      score: d.score,
      ups: d.ups,
      downs: d.downs,
      upvote_ratio: d.upvote_ratio,
      num_comments: d.num_comments,
      view_count: d.view_count,
      url: d.url,
      url_canonical: canonicalizeUrl(d.url),
      permalink: "https://www.reddit.com" + (d.permalink || ""),
      domain: d.domain,
      is_self: d.is_self,
      is_video: !!d.is_video,
      is_gallery: !!d.is_gallery,
      /* Reddit-native quality flags */
      over_18:        isOver18,
      stickied:       isModPinned,
      pinned:         !!d.pinned,
      spoiler:        isSpoiler,
      locked:         isLocked,
      removed:        isRemoved,
      removed_reason: removedReason,
      /* Live Reddit reports the score as of right now; the archive
       * reports whatever it last saw, which for a post submitted in the
       * past couple of days is still the placeholder it was created
       * with. The adapter stamps which one this is so charts and KPIs
       * can say "provisional" instead of quietly averaging in a 1. */
      score_confirmed: d.__scoreConfirmed !== false,
      score_asof: d.__scoreAsOf || null,
      flair: d.link_flair_text,
      flair_css: d.link_flair_css_class,
      total_awards: d.total_awards_received,
      crosspost_parent_id: d.crosspost_parent || (xpParent && xpParent.name) || null,
      crosspost_parent_sub: xpParent ? xpParent.subreddit : null,
      crosspost_parent_title: xpParent ? xpParent.title : null,
      selftext: isRemoved ? "" : (d.selftext || ""),
      thumbnail: d.thumbnail,
      /* Embedded-media metadata (see comment above). */
      media_title:    oe.title         || sm.title         || null,
      media_author:   oe.author_name   || null,
      media_provider: oe.provider_name || (m && m.type) || null,
      media_thumbnail: oe.thumbnail_url || null,
    };
  }

  /* Strip tracking params + collapse known equivalent hostnames so two
   * posts that link to "the same content with different garnish" group
   * together in cross-post detection. Leaves the original .url field
   * untouched (we still want to render it / link to it); only drives
   * the matching key. */
  /* Tracking params to drop. The first group is exact-match parameter
   * names; the second is prefix match (utm_*, mc_*, _ga*). */
  const TRACKING_EXACT = new Set(["ref","ref_src","ref_url","fbclid","gclid","igshid","si","t","feature","cid","src","spm","cmpid","smid","s","y","ncid","sr_share","share_id"]);
  const TRACKING_PREFIX = /^(utm_|mc_|ga_|_ga|_hs|hs)/i;
  const HOST_ALIASES = {
    "youtu.be":     "youtube.com",
    "m.youtube.com": "youtube.com",
    "music.youtube.com": "youtube.com",
    "old.reddit.com":   "reddit.com",
    "www.reddit.com":   "reddit.com",
    "new.reddit.com":   "reddit.com",
    "np.reddit.com":    "reddit.com",
    "i.redd.it":        "reddit.com",
    "v.redd.it":        "reddit.com",
    "mobile.twitter.com": "twitter.com",
    "x.com":            "twitter.com",
    "nitter.net":       "twitter.com",
    "m.facebook.com":   "facebook.com",
    "lm.facebook.com":  "facebook.com",
    "amp.cnn.com":      "cnn.com",
    "amp.theguardian.com": "theguardian.com",
  };
  function canonicalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
    /* self-text posts have url === permalink; use the permalink path
     * itself as the key — collapses /comments/<id>/* variants. */
    try {
      const u = new URL(rawUrl);
      let host = u.hostname.toLowerCase();
      if (host.startsWith("www.")) host = host.slice(4);
      if (HOST_ALIASES[host]) host = HOST_ALIASES[host];
      /* youtu.be/<id> -> youtube.com/watch?v=<id> */
      if (u.hostname === "youtu.be") {
        const id = u.pathname.replace(/^\/+/, "").split("/")[0];
        if (id) return "https://youtube.com/watch?v=" + id;
      }
      /* Strip tracking params, sort the rest for stable order. */
      const keep = [];
      for (const [k, v] of u.searchParams) {
        if (TRACKING_EXACT.has(k.toLowerCase())) continue;
        if (TRACKING_PREFIX.test(k)) continue;
        keep.push([k, v]);
      }
      keep.sort((a, b) => a[0].localeCompare(b[0]));
      const search = keep.length ? "?" + keep.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&") : "";
      /* Drop trailing slash on path (but not on root) and drop fragment. */
      let path = u.pathname.replace(/\/+$/, "") || "/";
      return "https://" + host + path + search;
    } catch (_) {
      return String(rawUrl).split("?")[0].replace(/\/+$/, "");
    }
  }
  Reddit.canonicalizeUrl = canonicalizeUrl;

  Reddit.normalizePost = normalizePost;

  /* ============================================================
   * SUBREDDIT SEARCH & ABOUT
   * ----------------------------------------------------------
   * Used by the correlation engine to discover *new* candidate
   * subreddits to recommend, beyond just the ones already loaded
   * in the dashboard.
   * ============================================================ */

  Reddit.searchSubreddits = async function (query, opts) {
    opts = opts || {};
    const limit = Math.min(opts.limit || 25, 100);
    const json = await fetchJson(`/subreddits/search.json`, {
      q: query,
      limit: limit,
      sort: opts.sort || "relevance",
      include_over_18: "off",
    });
    const children = (json && json.data && json.data.children) || [];
    return children
      .filter((c) => c && c.kind === "t5" && c.data)
      .map((c) => ({
        display_name: c.data.display_name,
        name: c.data.name,
        title: c.data.title || "",
        public_description: c.data.public_description || c.data.description || "",
        subscribers: c.data.subscribers || 0,
        active_user_count: c.data.active_user_count || 0,
        over18: !!c.data.over18,
        url: c.data.url,
        icon_img: c.data.icon_img || "",
        created_utc: c.data.created_utc || 0,
      }));
  };

  /* Site-wide post search. Used by candidate discovery to find which
   * subreddits are *currently active* on a topic, not just which sub
   * descriptions match the keyword. The set of distinct subreddit names
   * returned by these post results often reveals niche communities the
   * /subreddits/search endpoint never surfaces. */
  /* Returns [] rather than throwing when the active data source has no
   * site-wide search (the archive requires a subreddit or author
   * scope). Discovery treats an empty result as a skipped phase, which
   * is the truth: it still has subreddit search and the curated catalog
   * to work with. */
  Reddit.searchPostsSupported = function () {
    return transportsToTry().some((t) => t && t.build);
  };

  Reddit.searchPosts = async function (query, opts) {
    opts = opts || {};
    if (!Reddit.searchPostsSupported()) return [];
    const json = await fetchJson(`/search.json`, {
      q: query,
      limit: Math.min(opts.limit || 50, 100),
      sort: opts.sort || "top",
      t: opts.t || "month",
      type: "link",
      include_over_18: "off",
      restrict_sr: "off",
    });
    const children = (json && json.data && json.data.children) || [];
    return children
      .filter((c) => c && c.kind === "t3" && c.data)
      .map((c) => ({
        id: c.data.id,
        subreddit: c.data.subreddit,
        title: c.data.title,
        score: c.data.score,
        num_comments: c.data.num_comments,
        created_utc: c.data.created_utc,
      }));
  };

  /* Name-completion for the subreddit search box.
   *
   * /api/subreddit_autocomplete_v2 is what Reddit's own search field
   * uses: it answers in a fraction of the time /subreddits/search takes
   * and tolerates partial words, which is exactly what a typeahead
   * needs. It is not documented as a public endpoint though, so a
   * failure here is expected rather than exceptional — callers fall back
   * to searchSubreddits. */
  Reddit.autocompleteSubreddits = async function (query, opts) {
    opts = opts || {};
    const q = String(query || "").trim();
    if (!q) return [];
    let json;
    try {
      json = await fetchJson(`/api/subreddit_autocomplete_v2.json`, {
        query: q,
        limit: Math.min(opts.limit || 10, 25),
        include_over_18: "false",
        include_profiles: "false",
        typeahead_active: "true",
        search_query_id: "",
      });
    } catch (_) {
      return [];
    }
    const children = (json && json.data && json.data.children) || [];
    return children
      .filter((c) => c && c.kind === "t5" && c.data)
      .map((c) => ({
        display_name: c.data.display_name,
        name: c.data.name,
        title: c.data.title || "",
        public_description: c.data.public_description || "",
        subscribers: c.data.subscribers || 0,
        active_user_count: c.data.active_user_count || 0,
        over18: !!c.data.over18,
        url: c.data.url,
        icon_img: c.data.icon_img || c.data.community_icon || "",
        created_utc: c.data.created_utc || 0,
      }));
  };

  Reddit.fetchSubredditAbout = async function (name) {
    const sub = Util.normalizeSubName(name);
    const json = await fetchJson(`/r/${sub}/about.json`, {});
    const d = json && json.data;
    if (!d) return null;
    return {
      display_name: d.display_name,
      title: d.title,
      public_description: d.public_description || d.description || "",
      subscribers: d.subscribers || 0,
      active_user_count: d.active_user_count || 0,
      over18: !!d.over18,
      created_utc: d.created_utc || 0,
    };
  };

  /* ============================================================
   * SHARE URL RESOLUTION
   * ----------------------------------------------------------
   * Reddit mobile-share links look like
   *   https://www.reddit.com/r/<sub>/s/<token>
   * where <token> is opaque and 301-redirects to the canonical
   *   /r/<sub>/comments/<id>/<title>/
   * URL. We need the real <id> to populate /by_id. The CORS proxy
   * follows the redirect transparently and returns the destination
   * page; we then grep the first occurrence of "comments/<id>" out
   * of the body. That's reliable in practice because Reddit's HTML
   * embeds the canonical URL in <link rel="canonical">, og:url, and
   * the JSON blob, all very near the top of the document.
   * ============================================================ */

  Reddit.resolveShareUrl = async function (shareUrl) {
    /* Share links resolve by following a redirect and scraping the
     * canonical URL out of the HTML, so this needs a transport that
     * fetches an arbitrary page. The archive serves structured records,
     * not pages, and has nothing to offer here. */
    const transports = transportsToTry().filter((t) => t && t.build);
    /* Mirrors fetchJson's per-transport tracking so the user sees the
     * full chain of failures instead of just whichever proxy was last
     * in line. */
    const lastByTransport = new Map();
    function note(name, kind) { lastByTransport.set(name, kind); }
    for (const t of transports) {
      const target = t.build(shareUrl);
      const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      const tid = ctrl ? setTimeout(() => ctrl.abort(), 10000) : null;
      try {
        const res = await fetch(target, {
          method: "GET",
          credentials: "omit",
          headers: { Accept: "text/html, */*;q=0.5" },
          signal: ctrl && ctrl.signal,
        });
        if (!res.ok) { note(t.name, "HTTP " + res.status); continue; }
        const text = await res.text();
        if (looksLikeBlockedHtml(text)) {
          /* Reddit's "Blocked" interstitial has no canonical comments link.
           * Fall through to the next proxy. */
          note(t.name, "Reddit blocked page");
          continue;
        }
        const m = text.match(/comments\/([a-z0-9]{4,12})/i);
        if (m) {
          Reddit._lastTransport = t.name;
          return m[1].toLowerCase();
        }
        note(t.name, "no canonical id in response");
      } catch (e) {
        note(t.name, normalizeFetchKind(e));
      } finally {
        if (tid) clearTimeout(tid);
      }
    }
    const entries = Array.from(lastByTransport.entries());
    const kinds = new Set(entries.map(([, k]) => k));
    let summary;
    if (entries.length === 0) summary = "share URL resolution failed";
    else if (kinds.size === 1) summary = `share URL — all ${entries.length} prox${entries.length === 1 ? "y" : "ies"} ${entries[0][1]}`;
    else summary = `share URL — ${entries.map(([t, k]) => `${t}(${k})`).join(" · ")}`;
    const err = new Error(summary);
    err.attempts = entries.map(([t, k]) => ({ transport: t, kind: k }));
    throw err;
  };

  /* Resolve many share URLs concurrently. Returns
   *   { resolved: { url: id, ... }, failed: [{url, message}, ...] }
   * so the UI can render partial success without rejecting. Concurrency
   * 4 — share URL resolution downloads ~500KB of HTML each, so going
   * higher chews memory on phones. */
  Reddit.resolveShareUrls = async function (urls) {
    const cleaned = Util.uniqBy((urls || []).map(String).filter(Boolean), (x) => x);
    const resolved = {};
    const failed = [];
    await Util.pmap(cleaned, 4, async (u) => {
      try {
        const id = await Reddit.resolveShareUrl(u);
        resolved[u] = id;
      } catch (e) {
        failed.push({ url: u, message: (e && e.message) || String(e) });
      }
    });
    return { resolved, failed };
  };

  window.Reddit = Reddit;
})();
