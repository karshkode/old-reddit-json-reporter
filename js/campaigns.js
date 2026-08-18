/* Campaign manager.
 *
 * A campaign = {
 *   id, name, goalScore, goalComments, postIds[], createdAt,
 *   theme?: { kind, id, label, keywords, spheres, originPostId, articleId, articleLink }
 * }
 *
 * `theme.kind` is one of:
 *   trend     — curated desk topic (may predate any Reddit posts)
 *   syndicate — anchored on a news headline
 *   post      — single origin post
 *   posts     — aggregated set (copies and/or related material)
 *
 * postIds remain the Reddit material being totalled; the theme is what
 * the campaign is *about* when that set is empty or still growing.
 *
 * Storage strategy: maintain an in-memory mirror as the source of truth for
 * the page session, and try to persist it to localStorage. If persistence
 * fails (iOS Safari Private Browsing, "Block All Cookies", quota exceeded,
 * embedded WebView with storage disabled), the in-memory list still works
 * inside this tab and `Campaigns.persistError` records why.
 *
 * This guards against the previous failure mode where `localStorage.setItem`
 * threw synchronously and silently inside `Campaigns.add`, destroying any
 * record of the just-created campaign.
 */
(function () {
  const KEY = "rj.campaigns";
  /* Compressed-blob key (PR 7). When the JSON is large we store a
   * gzip+base64url payload here instead of the plain-text KEY, to fit
   * within the ~5MB localStorage quota even with hundreds of post IDs
   * across many campaigns. The plain-text KEY is cleared in that case
   * so we don't double-store. Reads check both keys. */
  const KEY_GZIP = "rj.campaigns.gz";
  const COMPRESS_THRESHOLD = 8 * 1024;     /* compress when JSON > 8KB */
  const Campaigns = {};

  let mirror = null;
  let persistError = null;

  /* ---------- Compression helpers (PR 7) ---------- */
  function utf8Encode(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    const bin = unescape(encodeURIComponent(s));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8Decode(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(bin));
  }
  function bytesToBase64Url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function base64UrlToBytes(s) {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function gzip(bytes) {
    if (typeof CompressionStream === "undefined") return null;
    try {
      const cs = new CompressionStream("gzip");
      const stream = new Blob([bytes]).stream().pipeThrough(cs);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (_) { return null; }
  }
  async function gunzip(bytes) {
    if (typeof DecompressionStream === "undefined") return null;
    try {
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (_) { return null; }
  }

  function loadFromStorage() {
    try {
      /* Plain-text path first (faster, no async). */
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      }
      /* Compressed path. Decoded synchronously by deferring to
       * loadCompressedFromStorage which uses async DecompressionStream
       * but returns a Promise. Because callers expect sync today, we
       * fall back to an empty list and kick off the async hydrate. */
      const gz = localStorage.getItem(KEY_GZIP);
      if (gz) {
        hydrateFromCompressed(gz);
        return [];  /* replaced once hydrate resolves */
      }
      return [];
    } catch (e) {
      persistError = e && e.message ? e.message : String(e);
      return [];
    }
  }
  async function hydrateFromCompressed(gzBase64) {
    try {
      const bytes = base64UrlToBytes(gzBase64);
      const decompressed = await gunzip(bytes);
      if (!decompressed) return;
      const json = utf8Decode(decompressed);
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) {
        mirror = parsed;
        if (typeof Campaigns.onHydrate === "function") {
          try { Campaigns.onHydrate(parsed); } catch (_) {}
        }
      }
    } catch (e) {
      persistError = e && e.message ? e.message : String(e);
    }
  }

  function ensureMirror() {
    if (mirror === null) mirror = loadFromStorage();
    return mirror;
  }

  function persist() {
    try {
      const json = JSON.stringify(mirror);
      /* Below threshold -> plain-text for instant reads. */
      if (json.length < COMPRESS_THRESHOLD) {
        localStorage.setItem(KEY, json);
        try { localStorage.removeItem(KEY_GZIP); } catch (_) {}
        persistError = null;
        return true;
      }
      /* Above threshold -> kick off async compression and store
       * both keys so reads (which run synchronously today) still
       * see SOMETHING immediately. */
      localStorage.setItem(KEY, json);
      persistError = null;
      persistCompressed(json).catch((e) => {
        console.warn("[campaigns] compression failed:", e && e.message);
      });
      return true;
    } catch (e) {
      persistError = e && e.message ? e.message : String(e);
      /* Plain-text write failed (likely quota). Try compressed-only. */
      persistCompressed(JSON.stringify(mirror)).catch(() => {});
      return false;
    }
  }
  async function persistCompressed(json) {
    if (typeof CompressionStream === "undefined") return;
    const bytes = utf8Encode(json);
    const gz = await gzip(bytes);
    if (!gz) return;
    /* Only swap to gzip storage when it actually saves space. */
    if (gz.length >= bytes.length * 0.9) return;
    try {
      localStorage.setItem(KEY_GZIP, bytesToBase64Url(gz));
      /* Drop the plain-text copy ONLY if the gzip write succeeded
       * (otherwise we'd lose data on quota errors). */
      localStorage.removeItem(KEY);
      persistError = null;
    } catch (e) {
      persistError = e && e.message ? e.message : String(e);
    }
  }

  Campaigns.canPersist = function () {
    /* Probe localStorage with a short throwaway key. Catches:
     * - Private Browsing on older Safari (throws)
     * - Cookies blocked / storage disabled (throws SecurityError)
     * - Quota exceeded
     */
    try {
      const k = "rj.probe." + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(k, "1");
      const ok = localStorage.getItem(k) === "1";
      localStorage.removeItem(k);
      return ok;
    } catch (_) {
      return false;
    }
  };

  Campaigns.persistErrorMessage = function () { return persistError; };

  Campaigns.list = function () { return ensureMirror().slice(); };

  function normalizeTheme(raw) {
    if (!raw || typeof raw !== "object") return null;
    const kind = String(raw.kind || "").toLowerCase();
    if (["trend", "syndicate", "post", "posts"].indexOf(kind) < 0) return null;
    const keywords = Array.isArray(raw.keywords)
      ? raw.keywords.map((k) => String(k || "").trim()).filter(Boolean).slice(0, 12)
      : [];
    const spheres = Array.isArray(raw.spheres)
      ? raw.spheres.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8)
      : [];
    return {
      kind: kind,
      id: raw.id ? String(raw.id) : "",
      label: String(raw.label || "").trim().slice(0, 120),
      keywords: keywords,
      spheres: spheres,
      originPostId: raw.originPostId ? String(raw.originPostId) : "",
      articleId: raw.articleId ? String(raw.articleId) : "",
      articleLink: raw.articleLink ? String(raw.articleLink) : "",
    };
  }

  Campaigns.normalizeTheme = normalizeTheme;

  Campaigns.themeKindLabel = function (theme) {
    if (!theme || !theme.kind) return "";
    if (theme.kind === "trend") return "Trend theme";
    if (theme.kind === "syndicate") return "Article theme";
    if (theme.kind === "posts") return "Post set";
    if (theme.kind === "post") return "Origin post";
    return "";
  };

  Campaigns.add = function (data) {
    ensureMirror();
    const id = Math.random().toString(36).slice(2, 10);
    const theme = normalizeTheme(data && data.theme);
    const c = {
      id,
      name: String(data && data.name || "Untitled campaign"),
      goalScore: Number(data && data.goalScore) || 0,
      goalComments: Number(data && data.goalComments) || 0,
      postIds: Util.uniqBy(((data && data.postIds) || []).map(String), (x) => x),
      createdAt: Date.now(),
    };
    if (theme) c.theme = theme;
    mirror.push(c);
    persist();
    return c;
  };

  /* Theme-first campaign from a Trending desk topic. Attaches matching
   * inventory posts when present; empty postIds are fine — the theme is
   * the anchor until material is posted or linked. */
  Campaigns.fromTrend = function (topic, opts) {
    opts = opts || {};
    if (!topic || !topic.label) throw new Error("No trend topic to campaign on.");
    const posts = Array.isArray(opts.posts) ? opts.posts : [];
    const headline = (topic.headlines && topic.headlines[0]) || opts.article || null;
    const origin = posts[0] || null;
    return Campaigns.add({
      name: opts.name || topic.label,
      postIds: posts.map((p) => p && p.id).filter(Boolean),
      goalScore: opts.goalScore,
      goalComments: opts.goalComments,
      theme: {
        kind: "trend",
        id: topic.id || "",
        label: topic.label,
        keywords: topic.keywords || [],
        spheres: topic.spheres || [],
        originPostId: origin && origin.id,
        articleId: headline && headline.id,
        articleLink: headline && headline.link,
      },
    });
  };

  /* Campaign anchored on a Syndicate headline (not a Reddit copy set). */
  Campaigns.fromSyndicate = function (article, opts) {
    opts = opts || {};
    if (!article || !(article.title || article.id)) throw new Error("No article to campaign on.");
    const posts = Array.isArray(opts.posts) ? opts.posts : [];
    const title = String(article.title || "Untitled article").trim();
    return Campaigns.add({
      name: opts.name || title.slice(0, 60),
      postIds: posts.map((p) => p && p.id).filter(Boolean),
      goalScore: opts.goalScore,
      goalComments: opts.goalComments,
      theme: {
        kind: "syndicate",
        id: article.id || "",
        label: title.slice(0, 120),
        keywords: opts.keywords || [],
        spheres: opts.spheres || [],
        articleId: article.id || "",
        articleLink: article.link || "",
        originPostId: posts[0] && posts[0].id,
      },
    });
  };

  /* Campaign from an origin post, optionally folding known copies.
   * Unlike Crosspost.track, a single community is enough — the post is
   * the theme anchor; more copies can join later. */
  Campaigns.fromOriginPost = function (post, opts) {
    opts = opts || {};
    if (!post || !post.id) throw new Error("No post to campaign on.");
    let posts = [post];
    if (opts.includeCopies !== false && window.Crosspost && Crosspost.copiesOf) {
      const copies = Crosspost.copiesOf(post) || [];
      const seen = new Set([String(post.id)]);
      for (const c of copies) {
        if (!c || !c.id || seen.has(String(c.id))) continue;
        seen.add(String(c.id));
        posts.push(c);
      }
    }
    if (window.Analyze && Analyze.adopt) {
      for (const p of posts) {
        try { Analyze.adopt(p); } catch (_) {}
      }
    }
    const title = String(post.title || "").trim();
    const multi = posts.length > 1;
    return Campaigns.add({
      name: opts.name || (title ? title.slice(0, 60) : `r/${post.subreddit} post`),
      postIds: posts.map((p) => p.id).filter(Boolean),
      goalScore: opts.goalScore,
      goalComments: opts.goalComments,
      theme: {
        kind: multi ? "posts" : "post",
        label: title.slice(0, 120) || `r/${post.subreddit}`,
        keywords: opts.keywords || [],
        spheres: opts.spheres || [],
        originPostId: post.id,
      },
    });
  };

  /* Resolve a campaign's member posts from whatever is on hand — the
   * campaign summary cache first, the loaded inventory second. Shared
   * by asPost (matching profile) and the Plan composer (what to post). */
  Campaigns.resolvePosts = function (campaign, opts) {
    opts = opts || {};
    if (!campaign) return [];
    let posts = Array.isArray(opts.posts) ? opts.posts.slice() : null;
    if (!posts) {
      const idSet = new Set(campaign.postIds || []);
      const summary = (window.AppState && AppState.campaignSummaries)
        ? AppState.campaignSummaries[campaign.id]
        : null;
      posts = (summary && summary.posts ? summary.posts : []).filter((p) => p && idSet.has(p.id));
      if (!posts.length && window.AppState && Array.isArray(AppState.posts)) {
        posts = AppState.posts.filter((p) => p && idSet.has(p.id));
      }
    }
    posts.sort((a, b) => (b.score || 0) - (a.score || 0));
    return posts;
  };

  /* ------------------------------------------------------------------
   * PLAN COMPOSER — what actually gets submitted for a campaign
   * ------------------------------------------------------------------
   * Ranking a campaign uses the whole profile (theme keywords + every
   * member post), but a submit page needs ONE headline and ONE piece of
   * content. The compose choice — headline text plus a content source —
   * is the user's answer, stored on the campaign so it survives reloads:
   *   campaign.compose = { title: "…", source: "article" | "post:<id>" | "text" }
   * Resolution back to a { title, body, url, isLinkPost } draft happens
   * at link-build time, so a member post that gained a better URL after
   * a sync is picked up automatically.
   */

  /* Every content source this campaign could submit: the theme article
   * link, each member post (its external link, or its body for self
   * posts), and a fresh empty text post. */
  Campaigns.composeOptions = function (campaign, opts) {
    if (!campaign) return [];
    const theme = campaign.theme || null;
    const out = [];
    if (theme && theme.articleLink) {
      let domain = "";
      try { domain = new URL(theme.articleLink).hostname.replace(/^www\./, ""); } catch (_) {}
      out.push({
        id: "article",
        kind: "link",
        url: theme.articleLink,
        label: "Article link" + (domain ? " · " + domain : ""),
        title: theme.label || "",
      });
    }
    const posts = Campaigns.resolvePosts(campaign, opts);
    for (const p of posts.slice(0, 12)) {
      if (!p || !p.id) continue;
      const dest = (window.Util && Util.shareDestination) ? Util.shareDestination(p) : null;
      const self = !dest || dest.kind === "self";
      out.push({
        id: "post:" + p.id,
        kind: self ? "self" : "link",
        url: self ? "" : dest.url,
        body: self ? String(p.selftext || "") : "",
        label: "r/" + (p.subreddit || "?") + " · " + (window.Util ? Util.fmtNum(p.score || 0) : p.score || 0)
          + " pts · " + (self ? "text" : "link"),
        title: p.title || "",
        post: p,
      });
    }
    out.push({ id: "text", kind: "self", url: "", body: "", label: "Fresh text post — write it on Reddit", title: "" });
    return out;
  };

  /* Headlines worth offering: the campaign name, the theme label, and
   * each distinct member-post title. */
  Campaigns.headlineOptions = function (campaign, opts) {
    if (!campaign) return [];
    const seen = new Set();
    const out = [];
    const push = (text, from) => {
      const t = String(text || "").trim();
      if (!t || seen.has(t.toLowerCase())) return;
      seen.add(t.toLowerCase());
      out.push({ text: t, from: from });
    };
    push(campaign.name, "campaign name");
    if (campaign.theme) push(campaign.theme.label, "theme");
    for (const p of Campaigns.resolvePosts(campaign, opts).slice(0, 10)) {
      push(p && p.title, "r/" + ((p && p.subreddit) || "?"));
    }
    return out;
  };

  /* The current compose choice resolved to the draft shape that
   * Util.buildSubmitUrl understands. Falls back sensibly when nothing
   * was chosen: the campaign name over the article, else the best post,
   * else an empty text post. */
  Campaigns.composeDraft = function (campaign, opts) {
    if (!campaign) return null;
    const options = Campaigns.composeOptions(campaign, opts);
    const saved = campaign.compose || {};
    let source = options.find((o) => o.id === saved.source);
    if (!source) source = options[0] || { id: "text", kind: "self", url: "", body: "" };
    const title = String(saved.title || "").trim()
      || String(campaign.name || "").trim()
      || source.title
      || "Untitled";
    return {
      title: title.slice(0, 300),
      body: source.kind === "self" ? (source.body || "") : "",
      url: source.kind === "link" ? (source.url || "") : "",
      isLinkPost: source.kind === "link",
      sourceId: source.id,
      sourceLabel: source.label,
    };
  };

  /* The whole campaign folded into one pseudo-post so the single-post
   * engines (Focus / Plan, Discovery.forPost) can rank it like anything
   * else on the site. Theme keywords carry campaigns with no resolved
   * posts yet — a trend campaign is matchable from day zero. */
  Campaigns.asPost = function (campaign, opts) {
    opts = opts || {};
    if (!campaign) return null;
    const theme = campaign.theme || null;
    const posts = Campaigns.resolvePosts(campaign, opts);

    const bodyBits = [];
    if (theme && theme.label && theme.label !== campaign.name) bodyBits.push(theme.label);
    if (theme && theme.keywords && theme.keywords.length) bodyBits.push(theme.keywords.join(", "));
    if (campaign.tune && campaign.tune.extra) bodyBits.push(String(campaign.tune.extra));
    for (const p of posts.slice(0, 12)) {
      if (p && p.title) bodyBits.push(p.title);
    }
    const subs = new Set();
    for (const p of posts) {
      if (p && p.subreddit) subs.add(String(p.subreddit).toLowerCase());
    }
    return {
      id: "camp_" + campaign.id,
      campaignId: campaign.id,
      syndicated: true,
      title: campaign.name,
      selftext: bodyBits.join("\n"),
      is_self: true,
      url: (theme && theme.articleLink) || "",
      subreddit: "",
      suggested_sub: "",
      score: posts.reduce((n, p) => n + ((p && p.score) || 0), 0),
      num_comments: posts.reduce((n, p) => n + ((p && p.num_comments) || 0), 0),
      created_utc: Math.floor((campaign.createdAt || Date.now()) / 1000),
      campaign_subs: Array.from(subs),
      source_label: (Campaigns.themeKindLabel(theme) || "Campaign") + " · " + (campaign.name || "Campaign"),
    };
  };

  Campaigns.remove = function (id) {
    ensureMirror();
    mirror = mirror.filter((c) => c.id !== id);
    persist();
  };

  /* Drop everything. persist() writes an empty list rather than
   * removing the key, so a later read cannot fall back to a stale
   * gzip mirror of the campaigns this just deleted. */
  Campaigns.clear = function () {
    ensureMirror();
    const n = mirror.length;
    mirror = [];
    persist();
    return n;
  };

  Campaigns.get = function (id) {
    return ensureMirror().find((c) => c.id === id) || null;
  };

  Campaigns.update = function (id, patch) {
    ensureMirror();
    const i = mirror.findIndex((c) => c.id === id);
    if (i < 0) return null;
    const next = Object.assign({}, mirror[i], patch);
    if (patch && Object.prototype.hasOwnProperty.call(patch, "theme")) {
      next.theme = normalizeTheme(patch.theme);
      if (!next.theme) delete next.theme;
    }
    mirror[i] = next;
    persist();
    return mirror[i];
  };

  /* Append post IDs to an existing campaign, deduping against the
   * existing list. Returns { campaign, added } where `added` is the
   * count of IDs that were actually new. */
  Campaigns.addPostIds = function (id, idsToAdd) {
    ensureMirror();
    const i = mirror.findIndex((c) => c.id === id);
    if (i < 0) return null;
    const existing = new Set(mirror[i].postIds);
    const merged = mirror[i].postIds.slice();
    /* Track WHICH ids are new vs duplicates so the UI can echo
     * the new IDs back to the user as confirmation chips. Without
     * this, a stuck-feeling user (paste, click Add, see a toast,
     * miss it, look at the still-failing campaign) had no easy
     * way to verify their paste actually landed. */
    const addedIds = [];
    for (const newId of (idsToAdd || []).map(String).filter(Boolean)) {
      if (!existing.has(newId)) {
        existing.add(newId);
        merged.push(newId);
        addedIds.push(newId);
      }
    }
    mirror[i] = Object.assign({}, mirror[i], { postIds: merged });
    persist();
    return { campaign: mirror[i], added: addedIds.length, addedIds };
  };

  /* Remove post IDs from a campaign. Returns { campaign, removed }. */
  Campaigns.removePostIds = function (id, idsToRemove) {
    ensureMirror();
    const i = mirror.findIndex((c) => c.id === id);
    if (i < 0) return null;
    const removeSet = new Set((idsToRemove || []).map(String));
    const filtered = mirror[i].postIds.filter((pid) => !removeSet.has(pid));
    const removed = mirror[i].postIds.length - filtered.length;
    mirror[i] = Object.assign({}, mirror[i], { postIds: filtered });
    persist();
    return { campaign: mirror[i], removed };
  };

  /* Fetch live aggregated data for a campaign.
   *
   * If the caller passes options.fromPosts (typically the dashboard's
   * already-loaded subreddit posts) we resolve as many campaign IDs as
   * possible from that local cache before going to the network. The
   * remaining IDs are fetched via Reddit.fetchPostsByIds, which itself
   * falls back to per-ID /comments lookups if /by_id fails.
   *
   * options.skipNetwork = true returns just the local matches (useful for
   * an instant first paint before a slow refresh). */
  Campaigns.fetchAggregated = async function (campaign, options) {
    options = options || {};
    const localPosts = Array.isArray(options.fromPosts) ? options.fromPosts : [];
    const idSet = new Set(campaign.postIds);
    const localById = new Map();
    for (const p of localPosts) {
      if (p && p.id && idSet.has(p.id)) localById.set(p.id, p);
    }
    const knownPosts = Array.from(localById.values());
    const idsToFetch = campaign.postIds.filter((id) => !localById.has(id));

    let fetched = [];
    let networkError = null;
    if (!options.skipNetwork && idsToFetch.length) {
      fetched = await Reddit.fetchPostsByIds(idsToFetch);
      /* fetchPostsByIds attaches the last network error as a
       * non-enumerable _lastError when EVERY ID failed to resolve.
       * Surface it so the campaign-detail UI can name the actual
       * failure rather than showing an opaque 'Could not resolve'
       * list. */
      if (fetched.length === 0 && fetched._lastError) {
        networkError = fetched._lastError.message || String(fetched._lastError);
      }
    }

    /* Merge local + fetched, then dedupe by id. */
    const seen = new Set();
    const posts = [];
    for (const p of [...knownPosts, ...fetched]) {
      if (p && !seen.has(p.id)) { seen.add(p.id); posts.push(p); }
    }

    const totalScore = posts.reduce((a, b) => a + (b.score || 0), 0);
    const totalComments = posts.reduce((a, b) => a + (b.num_comments || 0), 0);
    const totalAwards = posts.reduce((a, b) => a + (b.total_awards || 0), 0);
    const totalViews = posts.reduce((a, b) => a + (b.view_count || 0), 0);
    const subs = Array.from(new Set(posts.map((p) => p.subreddit))).filter(Boolean);
    const missing = campaign.postIds.filter((id) => !posts.find((p) => p.id === id));
    return {
      posts, totalScore, totalComments, totalAwards, totalViews,
      subs, missing, networkError,
      resolvedFromLocal: knownPosts.length,
      resolvedFromNetwork: fetched.length,
      progressScore: campaign.goalScore ? Math.min(1, totalScore / campaign.goalScore) : null,
      progressComments: campaign.goalComments ? Math.min(1, totalComments / campaign.goalComments) : null,
    };
  };

  /* Manual import / export — useful when storage is broken so the user
   * can copy their campaigns to a note app or another device. */
  Campaigns.exportJson = function () {
    return JSON.stringify(ensureMirror(), null, 2);
  };
  Campaigns.importJson = function (text) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("expected an array");
      mirror = parsed;
      persist();
      return true;
    } catch (_) { return false; }
  };

  window.Campaigns = Campaigns;
})();
