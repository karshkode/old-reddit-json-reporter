/* Reddit data access.
 *
 * Every request in this file is answered by the Arctic Shift archive
 * (js/archive.js), which is the dashboard's only data source. The archive
 * is not a proxy for reddit.com: it is a separate public mirror that
 * ingests Reddit continuously and serves the stored records with
 * `Access-Control-Allow-Origin: *`, so the browser reads it directly, with
 * no proxy, no worker, no account and no CORS problem to solve.
 *
 * WHY THERE IS NOTHING ELSE HERE
 *
 *   Reddit answers 403 "Blocked due to a network policy" to every
 *   unauthenticated request from a datacenter IP. Public CORS proxies and
 *   a personal Cloudflare Worker are both datacenter IPs, so no link in
 *   the proxy chain this file used to carry could reach Reddit at all.
 *   Keeping the chain only bought the user half a minute of timeouts
 *   before the archive answered anyway.
 *
 * THE REDDIT URL IS AN INTERNAL REQUEST GRAMMAR
 *
 *   fetchJson still composes a canonical https://www.reddit.com/… URL and
 *   hands it to Archive.fetchRedditUrl, which translates it into archive
 *   queries and translates the answer back into Reddit's JSON envelope.
 *   That indirection is deliberate rather than left over: Reddit's URL
 *   grammar is a compact, already-documented way to name a request, it
 *   makes a natural cache key, and it keeps the adapter replaceable
 *   without touching a caller. Everything downstream — normalizePost, the
 *   pagination loop, the comment parser — speaks Reddit's shapes for the
 *   same reason.
 *
 * WHAT THE ARCHIVE CANNOT DO
 *
 *   Site-wide post search and mobile share-link expansion both require
 *   reddit.com itself, so they are gone rather than stubbed: callers get
 *   an explicit refusal that explains the alternative. Scores on posts
 *   from the last couple of days are provisional until the archive
 *   re-scans them (Archive.SCORE_LAG_HOURS); normalizePost stamps every
 *   post with score_confirmed so the UI can label those rows instead of
 *   quietly charting a placeholder.
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
  /* One hard timeout per attempt. The archive normally answers a page in
   * a few hundred milliseconds, so anything past this is a stall rather
   * than a slow response, and waiting longer just delays the retry. */
  const REQUEST_TIMEOUT_MS = 8000;

  /* Human-readable name of the source, for status lines and errors. */
  Reddit.SOURCE_LABEL = "Arctic Shift archive";
  Reddit.SOURCE_HOME = "https://arctic-shift.photon-reddit.com";

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

  /* Normalize browser-specific fetch failure messages into a single
   * plain-language label. Without this, users see Safari's
   * "TypeError: Load failed" or Chrome's "Failed to fetch" or
   * Firefox's "NetworkError when attempting to fetch resource" and
   * can't tell whether the archive is down or their own connection is.
   * The root cause is the same for all three: the browser could not
   * complete the request. */
  function normalizeFetchKind(e) {
    if (!e) return "the archive did not respond";
    if (e.name === "AbortError") return "the archive timed out";
    const m = String(e.message || e || "").trim();
    if (m === "Load failed" || m === "Failed to fetch" || /networkerror/i.test(m)) {
      return "couldn't reach the archive — check your connection";
    }
    return m || "the archive did not respond";
  }

  /* One request to the archive, with a hard timeout so a stalled
   * connection cannot hold the caller open indefinitely.
   *
   * Two error classes come back out, and they mean opposite things:
   * an `archiveUnsupported` error says the archive is healthy but
   * structurally cannot answer this question (site-wide search), which
   * is routing information rather than an outage, so it must not be
   * retried or counted against the breaker. Everything else is a real
   * failure. */
  async function fetchFromArchive(redditUrl) {
    const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const tid = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      return await Archive.fetchRedditUrl(redditUrl, { signal: controller && controller.signal });
    } catch (e) {
      if (window.Archive && Archive.isUnsupported(e)) throw e;
      const err = new Error(normalizeFetchKind(e));
      if (e && e.status) err.status = e.status;
      throw err;
    } finally {
      if (tid) clearTimeout(tid);
    }
  }

  /* Circuit breaker — after N consecutive failures, fast-fail the next
   * calls instead of making every one of them wait out its own timeout.
   * The case this exists for is a phone that lost signal midway through
   * loading a dozen subreddits: without it the user sits through twelve
   * timeouts to learn the same thing once. It re-arms itself after a
   * cool-off, and Refresh clears it immediately. */
  const CIRCUIT_BREAKER_THRESHOLD = 3;       // consecutive failures
  const CIRCUIT_BREAKER_COOL_MS   = 60000;   // 1 min before re-probe
  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;
  function tripCircuitBreaker(summaryError) {
    consecutiveFailures++;
    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOL_MS;
      consecutiveFailures = 0;
      Reddit._lastCircuitTripError = summaryError;
      console.warn("[reddit] circuit breaker OPEN — the archive is not answering; pausing fetches for", CIRCUIT_BREAKER_COOL_MS / 1000, "s");
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

  /* Fire-and-forget revalidation for SWR. Updates the cache for the
   * next caller and never throws — the caller already has usable data,
   * so a failure here is not worth interrupting them over. */
  function revalidateInBackground(redditUrl, key) {
    const promise = (async () => {
      try {
        cacheSet(key, await fetchFromArchive(redditUrl));
      } catch (_) { /* the stale value we already served stands */ }
    })().finally(() => { inflight.delete(key); });
    inflight.set(key, promise);
  }

  /* @param opts.fresh  Skip the cache READ for this call. A scoped sync
   *                    exists to find out what changed, and the whole
   *                    point is defeated if a five-minute-old response
   *                    answers instead. It cannot use clearCache()
   *                    either: emptying the cache to re-read one
   *                    subreddit makes the other hundred and seventy
   *                    pay for it on their next touch. The write still
   *                    happens, so everyone downstream benefits. */
  async function fetchJson(path, params, opts) {
    const url = new URL(BASE + path);
    url.searchParams.set("raw_json", "1");
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== "") url.searchParams.set(k, v);
      }
    }
    const redditUrl = url.toString();
    const key = url.pathname + "?" + url.searchParams.toString();
    const wantFresh = !!(opts && opts.fresh);
    const cached = wantFresh ? null : cacheGet(key);
    if (cached && cached.fresh) return cached.v;
    /* Stale-while-revalidate: return stale data immediately, but
     * kick off a background revalidate so the next call gets fresh
     * data without waiting. */
    if (cached && cached.stale && !inflight.has(key)) {
      revalidateInBackground(redditUrl, key);
      return cached.v;
    }
    if (inflight.has(key)) return inflight.get(key);

    /* Fast-fail while the breaker is open rather than making this
     * request discover the outage on its own clock. */
    if (isCircuitOpen()) {
      const last = Reddit._lastCircuitTripError || "the archive is not answering";
      const secsLeft = Math.ceil((circuitOpenUntil - Date.now()) / 1000);
      const err = new Error(`${last} (retrying in ${secsLeft}s — or tap Refresh)`);
      err.circuit = true;
      throw err;
    }

    const promise = (async () => {
      let lastErr = null;
      /* One retry. The archive's own failure modes are a rate limit or
       * a blip, both of which a short backoff clears; anything that
       * survives a second attempt is an outage that more attempts will
       * not fix. */
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const data = await fetchFromArchive(redditUrl);
          cacheSet(key, data);
          resetCircuitBreaker();
          return data;
        } catch (err) {
          /* A question the archive structurally cannot answer is not
           * an outage: hand it straight back untouched so the caller
           * can treat it as a skipped capability, and leave the
           * breaker alone. */
          if (err && err.archiveUnsupported) throw err;
          lastErr = err;
          if (attempt === 0) await Util.sleep(err && err.status === 429 ? 2000 : 400);
        }
      }

      const summary = (lastErr && lastErr.message) || "the archive did not respond";
      tripCircuitBreaker(summary);
      throw new Error(summary);
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
    const fetchOpts = opts.fresh ? { fresh: true } : undefined;
    const out = [];
    let after = null;
    const pageSize = Math.min(100, target);
    while (out.length < target) {
      const params = { limit: pageSize, t: time };
      if (after) params.after = after;
      const json = await fetchJson(`/r/${sub}/${listing}.json`, params, fetchOpts);
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
    }, opts.fresh ? { fresh: true } : undefined);
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

  /* Everywhere else this post already exists: the original it was
   * crossposted from, its sibling crossposts, and separate submissions
   * of the same link. Returns { original, duplicates[] } with the
   * pasted post filtered out of the duplicates.
   *
   * Empty is a normal answer — most posts are only posted once. */
  Reddit.fetchDuplicates = async function (postId, opts) {
    opts = opts || {};
    const id = String(postId).replace(/^t3_/, "");
    const json = await fetchJson(`/duplicates/${id}.json`, { limit: opts.limit || 50 });
    if (!Array.isArray(json) || json.length < 2) return { original: null, duplicates: [] };

    const kids = (envelope) => ((envelope && envelope.data && envelope.data.children) || [])
      .filter((c) => c && c.kind === "t3" && c.data)
      .map((c) => normalizePost(c.data));

    const original = kids(json[0])[0] || null;
    return { original: original, duplicates: kids(json[1]).filter((p) => p.id !== id) };
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

    /* Track the most recent network-level failure so callers
     * (Campaigns.fetchAggregated -> renderCampaignDetail) can surface
     * a meaningful error instead of just listing un-resolved IDs.
     * Attached to the returned array as a non-enumerable property
     * so existing array consumers keep working. */
    let lastError = null;
    const fetchOpts = opts.fresh ? { fresh: true } : undefined;

    /* Ask Reddit first when it can be asked.
     *
     * Everything else in this file reads the archive, and for posts
     * more than a day and a half old the archive is the better source:
     * complete, unmetered, and no token to keep alive. But a post from
     * this morning is filed in the archive at the score it was born
     * with, which is 1, and no amount of refreshing changes that until
     * the archive's second pass runs. Fetching by id is exactly the
     * call that means "tell me how these specific posts are doing right
     * now", so it is the one that goes to Reddit.
     *
     * js/live.js returns null rather than an empty array when it could
     * not ask — no token, rate limited, switched off — which is what
     * separates "Reddit says these are gone" from "we did not get to
     * find out", and only the second falls through to the archive. */
    if (window.Live && Live.available() && opts.live !== false) {
      const live = await Live.lookup(cleaned);
      if (live && live.length) {
        if (live.length === cleaned.length) return live;
        /* Reddit did not know about all of them — a post removed, or an
         * id from a subreddit it will not serve. Keep what it gave and
         * let the archive answer for the rest. */
        const got = new Set(live.map((p) => p.id));
        const missing = cleaned.filter((id) => !got.has(id));
        const rest = await Reddit.fetchPostsByIds(missing, Object.assign({}, opts, { live: false }));
        return live.concat(rest);
      }
    }

    /* Preferred path: batch via /by_id (one request per up-to-100 IDs). */
    try {
      const results = [];
      for (let i = 0; i < cleaned.length; i += 100) {
        const batch = cleaned.slice(i, i + 100).map((id) => "t3_" + id);
        const json = await fetchJson(`/by_id/${batch.join(",")}.json`, {}, fetchOpts);
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
     * concurrency 3. A batch is one archive query over a long id list,
     * and one missing or malformed id fails the lot; asking per id
     * salvages the rest. We accept partial success — any IDs that still
     * fail simply aren't included. */
    const results = [];
    await Util.pmap(cleaned, 3, async (id) => {
      try {
        const json = await fetchJson(`/comments/${id}.json`, { limit: 1 }, fetchOpts);
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

  /* Titles the archive substitutes for the real one when a post was
   * taken down. Reddit itself keeps the title on removal, so these are
   * a property of the archived record rather than of the post — a post
   * removed and later reinstated can still come back to us wearing one.
   *
   * They have to be recognised because they are not titles and must not
   * be treated as one. Left alone, every removed post across every
   * subreddit shares the same "title", which the cross-post detector
   * duly reads as one story cross-posted to twenty-seven communities. */
  const PLACEHOLDER_TITLE = /^\s*[\[(]\s*(?:removed|deleted|unavailable)\b[^\])]*[\])]\s*$/i;

  function isPlaceholderTitle(title) {
    return PLACEHOLDER_TITLE.test(String(title || ""));
  }
  Reddit.isPlaceholderTitle = isPlaceholderTitle;

  /* A placeholder is not the only thing we know about a post. A
   * crosspost carries its parent's title, and a link post carries the
   * oEmbed title of whatever it points at — either is the actual
   * subject, and showing it beats showing "[ Removed by moderator ]".
   * The substitution is recorded in title_source so the UI can say
   * where the words came from rather than passing them off as the
   * post's own. */
  function resolveTitle(d, xpParent, oe, sm) {
    const raw = d.title;
    if (!isPlaceholderTitle(raw)) return { title: raw, placeholder: false, source: null };
    const parent = xpParent && xpParent.title;
    if (parent && !isPlaceholderTitle(parent)) {
      return { title: parent, placeholder: true, source: "crosspost" };
    }
    const media = oe.title || sm.title;
    if (media) return { title: media, placeholder: true, source: "link" };
    return { title: raw, placeholder: true, source: null };
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
    const titled = resolveTitle(d, xpParent, oe, sm);
    return {
      id: d.id,
      fullname: d.name,
      subreddit: d.subreddit,
      subreddit_prefixed: d.subreddit_name_prefixed,
      title: titled.title,
      /* True when the archive gave us a removal placeholder where the
       * title should be, whether or not we found a substitute. */
      title_placeholder: titled.placeholder,
      title_source: titled.source,
      author: d.author,
      created_utc: d.created_utc,
      score: d.score,
      ups: d.ups,
      downs: d.downs,
      upvote_ratio: d.upvote_ratio,
      num_comments: d.num_comments,
      view_count: d.view_count,
      url: d.url,
      /* Destination Reddit would open for a link post — often the same
       * as url, but kept separately so share/submit can prefer the
       * real target when Reddit wraps media hosts. */
      url_dest: d.url_overridden_by_dest || d.url || null,
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
      crosspost_parent_url: xpParent ? (xpParent.url || null) : null,
      crosspost_parent_dest: xpParent
        ? (xpParent.url_overridden_by_dest || xpParent.url || null)
        : null,
      selftext: isRemoved ? "" : (d.selftext || ""),
      thumbnail: d.thumbnail,
      /* Embedded-media metadata (see comment above). */
      media_title:    oe.title         || sm.title         || null,
      media_author:   oe.author_name   || null,
      media_provider: oe.provider_name || (m && m.type) || null,
      media_thumbnail: oe.thumbnail_url || null,
      /* Direct playable file when Reddit hosted the video — last resort
       * for share URLs if nothing else embeds. */
      media_fallback_url: (m && m.reddit_video && m.reddit_video.fallback_url) || null,
      /* Free text attached to media without OCR: gallery captions and
       * oEmbed blurbs. Discovery folds these in so screenshot posts are
       * not stuck with only title + flair. */
      media_captions: (window.ImageText && ImageText.fromListing)
        ? ImageText.fromListing(d)
        : "",
      /* Largest preview URL when present — OCR fallback when url is not
       * a direct image (e.g. gallery wrapper). */
      preview_url: (function () {
        try {
          const p = d.preview && d.preview.images && d.preview.images[0];
          const src = p && p.source && p.source.url;
          return src ? String(src).replace(/&amp;/g, "&") : null;
        } catch (_) { return null; }
      })(),
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

  /* There is deliberately no site-wide post search here.
   *
   * Arctic Shift requires a subreddit or an author to scope a free-text
   * query, so "which communities across Reddit are posting about X" has
   * no honest answer from this source. Discovery used to mine that to
   * find active communities; it now leans on subreddit search, the
   * curated catalog and the local term index, and says so rather than
   * running a phase that can only ever return nothing.
   */

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
   * SHARE URLS
   * ----------------------------------------------------------
   * Reddit mobile-share links look like
   *   https://www.reddit.com/r/<sub>/s/<token>
   * where <token> is opaque and 301-redirects to the canonical
   *   /r/<sub>/comments/<id>/<title>/
   * URL that actually names the post.
   *
   * Expanding one means asking reddit.com to perform that redirect
   * and reading where it lands. The browser cannot do that itself —
   * reddit.com sends no CORS headers, and the token is a routing
   * record that lives nowhere but Reddit, so the archive has nothing
   * to look it up in. This used to work by having a CORS proxy follow
   * the redirect and scraping the canonical URL out of the returned
   * HTML; with the proxies gone, so is the capability.
   *
   * Rather than fail slowly and vaguely, the app refuses these up
   * front, everywhere one can be pasted, with the one instruction
   * that does work: open the link, then paste the URL it lands on.
   * ============================================================ */

  Reddit.SHARE_URL_HELP =
    "Share links (/s/…) can't be expanded without reddit.com. Open the link, then paste the /comments/… URL it lands on.";

  /* A constant, not a probe: no configuration or retry makes this
   * possible, so callers can branch on it while building their UI
   * instead of after a failed round-trip. */
  Reddit.shareUrlsResolvable = function () { return false; };

  Reddit.resolveShareUrl = async function () {
    const err = new Error(Reddit.SHARE_URL_HELP);
    err.shareUnresolvable = true;
    throw err;
  };

  /* Kept in its original shape — { resolved, failed } — because the
   * callers already render partial success, and a batch where every
   * entry failed for the same stated reason is exactly that shape. */
  Reddit.resolveShareUrls = async function (urls) {
    const cleaned = Util.uniqBy((urls || []).map(String).filter(Boolean), (x) => x);
    return {
      resolved: {},
      failed: cleaned.map((u) => ({ url: u, message: Reddit.SHARE_URL_HELP })),
    };
  };

  window.Reddit = Reddit;
})();
