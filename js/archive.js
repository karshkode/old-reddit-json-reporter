/* =====================================================================
 * ARCTIC SHIFT ARCHIVE TRANSPORT
 * ---------------------------------------------------------------------
 * A Reddit data source that does not touch reddit.com.
 *
 * WHY THIS EXISTS
 *
 *   Reddit now answers 403 "Blocked due to a network policy" to every
 *   unauthenticated request from a datacenter IP. That is not a
 *   user-agent problem and no amount of header tweaking fixes it — it
 *   is decided before the request reaches an application server. It
 *   takes out every CORS proxy the dashboard used to rely on, and it
 *   takes out a personal Cloudflare Worker too, because Workers egress
 *   from datacenter IPs like everything else. The only reddit.com
 *   endpoint that still answers is /api/v1/access_token, i.e. you are
 *   expected to register an app and use OAuth.
 *
 *   Arctic Shift (https://arctic-shift.photon-reddit.com) is a public
 *   Reddit archive that ingests posts and comments continuously and
 *   re-scans them later to pick up their final scores. It serves plain
 *   JSON with `Access-Control-Allow-Origin: *`, which means the browser
 *   can call it directly — no proxy, no worker, no credentials, and no
 *   CORS problem to solve in the first place.
 *
 * WHAT YOU GIVE UP
 *
 *   - Engagement numbers lag. A post is archived within minutes of
 *     being submitted, but its score is whatever it was at that moment
 *     (usually 1). The re-scan that fills in the real score and comment
 *     count lands roughly a day later. Recent-post analytics are
 *     therefore directionally useless; anything older than ~48h is
 *     accurate. `Archive.SCORE_LAG_HOURS` encodes that so the UI can
 *     say so out loud rather than quietly charting zeros.
 *   - No "hot" or "top" ranking. The archive sorts by time, not by
 *     Reddit's ranking algorithm, so those listings are approximated by
 *     pulling the requested time window and sorting locally by score.
 *   - No site-wide post search. Free-text search must be scoped to a
 *     subreddit or an author, so the discovery pipeline's "mine hot
 *     posts across all of Reddit" phase is unavailable and is skipped.
 *
 * The adapter's job is to make all of that look like Reddit's own JSON
 * API, because every consumer downstream — normalizePost, the listing
 * pagination loop, the comment parser — already speaks that shape.
 * Arctic Shift stores raw Reddit objects, so the field names line up
 * exactly and the translation is envelope-only.
 * ===================================================================== */
(function () {
  const Archive = {};

  const BASE = "https://arctic-shift.photon-reddit.com/api";

  /* The archive caps a single response at 100 records, same as Reddit. */
  const MAX_PAGE = 100;

  /* How long after submission the re-scan typically lands. Used by the
   * UI to caveat recent numbers rather than present them as fact. */
  Archive.SCORE_LAG_HOURS = 48;

  Archive.BASE = BASE;
  Archive.LABEL = "Arctic Shift archive";
  Archive.HOME = "https://arctic-shift.photon-reddit.com";

  /* Pagination cursors are ours to define — Reddit's `after` is an
   * opaque fullname and the caller only ever echoes it back to us, so
   * we use it to carry the oldest timestamp of the previous page. */
  const CURSOR_PREFIX = "as_";

  /* Reddit's `t` window names, in seconds. */
  const WINDOWS = {
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2592000,
    year: 31536000,
    all: 0,
  };

  /* ==================================================================
   * ERRORS
   * ================================================================== */

  /* Tagged so the transport layer can tell "the archive cannot answer
   * this kind of question" apart from "the archive is down". The former
   * should not count against the proxy's health or trip a retry. */
  function unsupported(what) {
    const err = new Error("the archive cannot serve " + what);
    err.archiveUnsupported = true;
    return err;
  }

  Archive.isUnsupported = function (err) {
    return !!(err && err.archiveUnsupported);
  };

  /* ==================================================================
   * TRANSPORT
   * ================================================================== */

  async function get(path, params, signal) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null && v !== "") url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal: signal,
    });

    if (res.status === 429) {
      const reset = res.headers.get("x-ratelimit-reset");
      const err = new Error("archive rate limited" + (reset ? ` (retry in ${reset}s)` : ""));
      err.status = 429;
      throw err;
    }
    if (!res.ok) throw new Error("archive HTTP " + res.status);

    const json = await res.json();
    /* The archive reports argument errors as 200 + {data:null,error}. */
    if (json && json.error) throw new Error("archive: " + json.error);
    return (json && json.data) || [];
  }

  /* ==================================================================
   * ENVELOPES
   * ------------------------------------------------------------------
   * Rebuild the exact shapes reddit.js already parses.
   * ================================================================== */

  function listing(records, kind, after) {
    return {
      kind: "Listing",
      data: {
        after: after || null,
        before: null,
        dist: records.length,
        children: records.map((r) => ({ kind: kind, data: r })),
      },
    };
  }

  function cursorFor(posts) {
    if (posts.length < 1) return null;
    let oldest = Infinity;
    for (const p of posts) {
      const t = Number(p.created_utc) || 0;
      if (t && t < oldest) oldest = t;
    }
    return oldest === Infinity ? null : CURSOR_PREFIX + oldest;
  }

  function parseCursor(after) {
    if (!after || typeof after !== "string") return null;
    if (after.indexOf(CURSOR_PREFIX) !== 0) return null;
    const t = parseInt(after.slice(CURSOR_PREFIX.length), 10);
    return isFinite(t) && t > 0 ? t : null;
  }

  /* ==================================================================
   * ROUTES
   * ================================================================== */

  /* A post enters the archive within minutes of being submitted, with
   * whatever score it had at that moment — almost always 1. A later
   * pass re-reads it and records the real numbers, stamping
   * `_meta.retrieved_2nd_on`. That stamp is the difference between a
   * score you can chart and a placeholder, so it is the thing to filter
   * and flag on, rather than guessing from the post's age. */
  function scoreConfirmed(record) {
    return !!(record && record._meta && record._meta.retrieved_2nd_on);
  }

  function stamp(record) {
    record.__scoreConfirmed = scoreConfirmed(record);
    record.__scoreAsOf = (record._meta && record._meta.retrieved_2nd_on) || null;
    return record;
  }

  /* Listings that mean "show me what did well" are worthless if most of
   * the rows are still sitting at their placeholder score, so those pull
   * only confirmed records. Listings that mean "show me what is new"
   * keep everything and let the UI flag the provisional rows. */
  const RANKED_LISTINGS = { hot: true, top: true, controversial: true, best: true };

  /* /r/<sub>/<listing>.json — the dashboard's bread and butter. */
  async function subredditListing(sub, listingName, q, signal) {
    const limit = Math.min(parseInt(q.get("limit"), 10) || MAX_PAGE, MAX_PAGE);
    const windowSecs = WINDOWS[q.get("t") || "week"];
    const cursor = parseCursor(q.get("after"));
    const ranked = !!RANKED_LISTINGS[listingName];

    const params = { subreddit: sub, limit: limit, sort: "desc" };

    if (cursor) {
      params.before = cursor;
    } else if (ranked) {
      /* Start the walk back at the point where scores have generally
       * settled, instead of burning the first page on rows we would
       * only throw away. */
      params.before = Math.floor(Date.now() / 1000) - Archive.SCORE_LAG_HOURS * 3600;
    }
    if (windowSecs && ranked) {
      params.after = Math.floor(Date.now() / 1000) - windowSecs;
    }

    const raw = await get("/posts/search", params, signal);
    /* The cursor has to come from the unfiltered page: it marks where
     * to resume reading, which is independent of what we chose to keep. */
    const after = raw.length >= limit ? cursorFor(raw) : null;

    let posts = raw.map(stamp);
    if (ranked) posts = posts.filter((p) => p.__scoreConfirmed);
    if (listingName === "top" || listingName === "controversial") {
      posts.sort((a, b) => (b.score || 0) - (a.score || 0));
    }
    return listing(posts, "t3", after);
  }

  /* /comments/<id>.json — Reddit answers with a two-element array:
   * a listing holding the post, then a listing holding the comments. */
  async function postWithComments(id, q, signal) {
    const limit = Math.min(parseInt(q.get("limit"), 10) || 50, MAX_PAGE);
    const fullname = "t3_" + String(id).replace(/^t3_/, "");

    const [posts, comments] = await Promise.all([
      get("/posts/ids", { ids: fullname }, signal),
      /* A comment limit of 1 means the caller only wants the post
       * (fetchPostsByIds' per-id fallback), so skip the second call. */
      limit <= 1 ? Promise.resolve([]) : get("/comments/search", { link_id: fullname, limit: limit }, signal),
    ]);

    if (!posts.length) throw new Error("archive has no post " + id);

    comments.sort((a, b) => (b.score || 0) - (a.score || 0));
    return [listing(posts.map(stamp), "t3", null), listing(comments, "t1", null)];
  }

  /* /by_id/t3_a,t3_b.json */
  async function byId(fullnames, signal) {
    const ids = String(fullnames)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.indexOf("t3_") === 0 ? s : "t3_" + s));
    if (!ids.length) return listing([], "t3", null);

    const posts = await get("/posts/ids", { ids: ids.join(",") }, signal);
    return listing(posts.map(stamp), "t3", null);
  }

  /* /subreddits/search.json and /api/subreddit_autocomplete_v2.json.
   *
   * The archive matches on a name prefix rather than Reddit's fuzzy
   * relevance search, so a multi-word query is reduced to its longest
   * word — "tenant rights" finds r/TenantRights but not r/Renters. The
   * catalog and the local SubIndex cover that gap in Discovery. */
  async function subredditSearch(query, limitRaw, signal) {
    const limit = Math.min(parseInt(limitRaw, 10) || 25, MAX_PAGE);
    const q = String(query || "").trim().replace(/^\/?r\//i, "");
    if (!q) return listing([], "t5", null);

    const word = q.split(/\s+/).sort((a, b) => b.length - a.length)[0] || q;
    const subs = await get("/subreddits/search", { subreddit_prefix: word, limit: limit }, signal);
    return listing(subs, "t5", null);
  }

  /* /r/<sub>/about.json — a bare t5, not a listing. */
  async function subredditAbout(sub, signal) {
    const subs = await get("/subreddits/search", { subreddit: sub, limit: 1 }, signal);
    if (!subs.length) throw new Error("archive has no subreddit " + sub);
    return { kind: "t5", data: subs[0] };
  }

  /* /r/<sub>/search.json — scoped search is supported. */
  async function subredditPostSearch(sub, q, signal) {
    const limit = Math.min(parseInt(q.get("limit"), 10) || 25, MAX_PAGE);
    const query = q.get("q") || q.get("query") || "";
    if (!query) return listing([], "t3", null);

    const posts = await get("/posts/search", {
      subreddit: sub,
      query: query,
      limit: limit,
      sort: "desc",
    }, signal);
    return listing(posts, "t3", null);
  }

  /* ==================================================================
   * DISPATCH
   * ------------------------------------------------------------------
   * Takes the reddit.com URL reddit.js would have fetched and answers
   * it from the archive instead.
   * ================================================================== */

  Archive.fetchRedditUrl = async function (redditUrl, opts) {
    opts = opts || {};
    const signal = opts.signal;

    let u;
    try {
      u = new URL(redditUrl);
    } catch (_) {
      throw new Error("archive: bad URL " + redditUrl);
    }

    const q = u.searchParams;
    const path = u.pathname.replace(/\.json$/, "").replace(/\/+$/, "") || "/";

    let m;

    if ((m = path.match(/^\/r\/([^/]+)\/about$/i))) {
      return subredditAbout(m[1], signal);
    }
    if ((m = path.match(/^\/r\/([^/]+)\/search$/i))) {
      return subredditPostSearch(m[1], q, signal);
    }
    if ((m = path.match(/^\/r\/([^/]+)\/(hot|new|top|rising|best|controversial)$/i))) {
      return subredditListing(m[1], m[2].toLowerCase(), q, signal);
    }
    if ((m = path.match(/^\/r\/([^/]+)$/i))) {
      return subredditListing(m[1], "hot", q, signal);
    }
    if ((m = path.match(/^\/comments\/([a-z0-9]+)/i))) {
      return postWithComments(m[1], q, signal);
    }
    if ((m = path.match(/^\/by_id\/(.+)$/i))) {
      return byId(m[1], signal);
    }
    if (path === "/subreddits/search" || path === "/api/subreddit_autocomplete_v2") {
      return subredditSearch(q.get("q") || q.get("query"), q.get("limit"), signal);
    }

    /* Site-wide post search. Arctic Shift requires a subreddit or author
     * scope for free-text queries, so there is no honest way to answer
     * "what is everyone on Reddit saying about X". Discovery treats this
     * as a skipped phase rather than a failure. */
    if (path === "/search") {
      throw unsupported("site-wide post search");
    }

    throw unsupported(path);
  };

  /* A cheap liveness probe for the data-source picker. */
  Archive.ping = async function (signal) {
    const t0 = Date.now();
    const subs = await get("/subreddits/search", { subreddit: "politics", limit: 1 }, signal);
    return { ok: subs.length > 0, ms: Date.now() - t0 };
  };

  window.Archive = Archive;
})();
