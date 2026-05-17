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
  const memCache = new Map();
  const inflight = new Map();
  const STORAGE_KEY = "rj.transport";

  /* A "transport" wraps a Reddit URL into a CORS-friendly request.
   * Each transport's `build(redditUrl)` returns the URL the browser hits.
   *
   * `direct` only works if the user has installed a CORS-disabling browser
   * extension or if a future Reddit policy change adds CORS support; we
   * keep it as a manual option but never auto-pick it.
   */
  const TRANSPORTS = [
    { name: "auto", label: "Auto (try proxies in order)" },
    { name: "codetabs", label: "codetabs.com proxy", build: (u) => "https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent(u) },
    { name: "allorigins", label: "allorigins.win proxy", build: (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u) },
    { name: "corsproxy", label: "corsproxy.io proxy", build: (u) => "https://corsproxy.io/?" + encodeURIComponent(u) },
    { name: "isomorphic", label: "isomorphic-git/cors-proxy", build: (u) => "https://cors.isomorphic-git.org/" + u.replace(/^https?:\/\//, "") },
    { name: "direct", label: "Direct (needs CORS unblocker)", build: (u) => u },
  ];
  Reddit.TRANSPORTS = TRANSPORTS;

  /* Auto-rotation order. `isomorphic` (cors.isomorphic-git.org) was
   * removed because the public deployment now returns 403 + 0 bytes
   * for every Reddit URL — it pollutes the auto chain with
   * "Load failed" errors that aren't actually informative. It's still
   * available as a manual option via the Data Source dropdown in
   * case the upstream comes back online. */
  const AUTO_ORDER = ["codetabs", "allorigins", "corsproxy"];

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

  function cacheGet(key) {
    const m = memCache.get(key);
    if (m && Date.now() - m.t < CACHE_TTL_MS) return m.v;
    try {
      const raw = sessionStorage.getItem("rj:" + key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.t < CACHE_TTL_MS) {
          memCache.set(key, parsed);
          return parsed.v;
        }
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
      const order = AUTO_ORDER.slice();
      // Bubble the most recently successful transport to the front so a
      // slow/dead proxy isn't tried first on every subsequent request.
      const last = Reddit._lastTransport;
      if (last && order.includes(last)) {
        const i = order.indexOf(last);
        if (i > 0) {
          const [t] = order.splice(i, 1);
          order.unshift(t);
        }
      }
      return order.map(getTransportByName).filter(Boolean);
    }
    const t = getTransportByName(preferredTransport);
    return t && t.build ? [t] : AUTO_ORDER.map(getTransportByName).filter(Boolean);
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
    const target = transport.build(redditUrl);
    /* 8s hard timeout per proxy attempt — without this a slow proxy can
     * block the entire fallback chain. AbortController is widely supported
     * including iOS Safari 12.1+. */
    const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const tid = controller ? setTimeout(() => controller.abort(), 8000) : null;
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
      throw throwTransportError(transport, "rate limited (429)", attempt);
    }
    if (!res.ok) {
      throw throwTransportError(transport, "HTTP " + res.status, attempt);
    }
    const text = await res.text();
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
      const isReddit404Etc = data.error === 403 || data.error === 404 || data.error === 429;
      const isProxyJunk = !data.data && !data.kind;
      if (isReddit404Etc) {
        throw throwTransportError(transport, "Reddit " + data.error + (data.message ? ": " + data.message : ""), attempt);
      }
      if (isProxyJunk) {
        const msg = typeof data.error === "string" ? data.error.slice(0, 80) : "error " + data.error;
        throw throwTransportError(transport, "proxy error: " + msg, attempt);
      }
    }
    return { data, transport: transport.name };
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
    if (cached) return cached;
    if (inflight.has(key)) return inflight.get(key);

    const promise = (async () => {
      const transports = transportsToTry();
      /* Per-transport latest failure. The map is keyed by transport
       * name; later attempts overwrite the kind for the same name so
       * we end up with one row per *transport* (not one per attempt),
       * deduplicated for display. */
      const lastByTransport = new Map();
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const t of transports) {
          try {
            const out = await tryTransport(t, redditUrl, attempt);
            cacheSet(key, out.data);
            Reddit._lastTransport = out.transport;
            if (typeof Reddit.onTransportSuccess === "function") Reddit.onTransportSuccess(out.transport);
            return out.data;
          } catch (err) {
            const tName = (err && err.transport) || (t && t.name) || "?";
            const kind = (err && err.kind) || (err && err.message) || String(err);
            lastByTransport.set(tName, kind);
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
        console.warn("[fetchPostsByIds] /comments/" + id + " failed:", e && e.message);
      }
    });
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
      permalink: "https://www.reddit.com" + (d.permalink || ""),
      domain: d.domain,
      is_self: d.is_self,
      is_video: !!d.is_video,
      is_gallery: !!d.is_gallery,
      over_18: d.over_18,
      stickied: d.stickied,
      spoiler: d.spoiler,
      locked: d.locked,
      flair: d.link_flair_text,
      flair_css: d.link_flair_css_class,
      total_awards: d.total_awards_received,
      crosspost_parent_id: d.crosspost_parent,
      selftext: d.selftext || "",
      thumbnail: d.thumbnail,
      /* Embedded-media metadata (see comment above). */
      media_title:    oe.title         || sm.title         || null,
      media_author:   oe.author_name   || null,
      media_provider: oe.provider_name || (m && m.type) || null,
      media_thumbnail: oe.thumbnail_url || null,
    };
  }

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
  Reddit.searchPosts = async function (query, opts) {
    opts = opts || {};
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
    const transports = transportsToTry();
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
