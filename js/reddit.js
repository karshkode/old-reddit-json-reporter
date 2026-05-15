/* Reddit JSON fetcher.
 *
 * Reddit serves anonymous JSON over HTTPS at:
 *   https://www.reddit.com/r/<sub>/<listing>.json
 *   https://www.reddit.com/comments/<id>.json
 *   https://www.reddit.com/by_id/t3_<id>.json
 *
 * old.reddit.com mirrors the same endpoints. We default to www.reddit.com
 * because it is more reliably served with permissive CORS. Users can switch
 * via Reddit.setBase().
 *
 * Reddit rate-limits anonymous requests; we throttle, retry with backoff,
 * and cache responses in-memory + sessionStorage for the page lifetime.
 */
(function () {
  const Reddit = {};

  let BASE = "https://www.reddit.com";
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const memCache = new Map();
  const inflight = new Map();

  Reddit.setBase = function (url) {
    BASE = url.replace(/\/$/, "");
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

  async function fetchJson(path, params) {
    const url = new URL(BASE + path);
    url.searchParams.set("raw_json", "1");
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== "") url.searchParams.set(k, v);
      }
    }
    const key = url.pathname + "?" + url.searchParams.toString();
    const cached = cacheGet(key);
    if (cached) return cached;
    if (inflight.has(key)) return inflight.get(key);

    const promise = (async () => {
      let attempt = 0;
      let lastErr;
      while (attempt < 4) {
        try {
          const res = await fetch(url.toString(), {
            method: "GET",
            credentials: "omit",
            headers: { Accept: "application/json" },
          });
          if (res.status === 429) {
            await Util.sleep(800 * Math.pow(2, attempt));
            attempt++;
            continue;
          }
          if (!res.ok) {
            throw new Error("HTTP " + res.status + " " + res.statusText);
          }
          const data = await res.json();
          cacheSet(key, data);
          return data;
        } catch (err) {
          lastErr = err;
          await Util.sleep(400 * Math.pow(2, attempt));
          attempt++;
        }
      }
      throw lastErr || new Error("fetch failed");
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
    let pageSize = Math.min(100, target);
    while (out.length < target) {
      const params = { limit: pageSize, t: time };
      if (after) params.after = after;
      const json = await fetchJson(`/r/${sub}/${listing}.json`, params);
      const children = (json && json.data && json.data.children) || [];
      if (!children.length) break;
      for (const c of children) {
        if (c && c.kind === "t3" && c.data) out.push(normalizePost(c.data));
        if (out.length >= target) break;
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
  Reddit.fetchPostsByIds = async function (ids) {
    const cleaned = Util.uniqBy(
      (ids || []).map((id) => String(id).replace(/^t3_/, "").trim()).filter(Boolean),
      (x) => x
    );
    if (!cleaned.length) return [];
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
      is_video: d.is_video,
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
    };
  }

  Reddit.normalizePost = normalizePost;

  window.Reddit = Reddit;
})();
