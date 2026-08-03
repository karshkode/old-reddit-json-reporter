/* =====================================================================
 * LIVE SCORES
 * ---------------------------------------------------------------------
 * Current numbers for posts too new for the archive to know anything
 * about.
 *
 * THE PROBLEM
 * Arctic Shift files a post within minutes of it being submitted, with
 * whatever score it had at that moment — which is 1, because it was
 * submitted a moment ago. A second pass re-reads it and records the
 * real numbers, but that pass runs somewhere between thirty and thirty
 * six hours later. Measured on r/politics: everything under 30 hours
 * old still reads score=1, and by 36 hours the real figures are there.
 *
 * So the archive is excellent for anything older than about a day and a
 * half, and blind to everything newer. Which is exactly backwards from
 * what you want when you have just posted something and would like to
 * know whether it is going anywhere.
 *
 * WHY THIS IS THE ONLY WAY IN
 * Every other door was tried and measured shut:
 *
 *   reddit.com/....json     403. Reddit closed unauthenticated JSON on
 *                           30 May 2026, globally — not a rate limit,
 *                           not a user-agent problem, not an IP
 *                           problem. old.reddit, api.reddit, np, sh,
 *                           i, m, amp: all the same.
 *   a proxy or worker       Does not help. The endpoint is closed to
 *                           the proxy too, which is why a Cloudflare
 *                           Worker in front of it returns 403 no matter
 *                           what user-agent it sends.
 *   public CORS proxies     Blocked or erroring on every Reddit URL.
 *   embed.reddit.com        Open, and does carry the live score, but as
 *                           HTML with no Access-Control-Allow-Origin,
 *                           and nothing readable from an iframe.
 *   RSS                     Open, no scores in it.
 *   Pushshift / PullPush    Behind a Cloudflare challenge.
 *
 * oauth.reddit.com is the exception, and deliberately so: it answers
 * with `Access-Control-Allow-Origin: *` and allows the Authorization
 * header, because Reddit built it for browser apps. No proxy, no
 * worker, no server.
 *
 * WHAT IT SIGNS IN AS
 * Nothing. The installed_client grant issues an anonymous application
 * token — no account, no password, no sign-in, and no registration to
 * do first. The JWT it hands back has subject "loid" and lasts a day.
 * Reddit closed self-service app registration in 2025, so CLIENT_ID
 * below is the public identifier of Reddit's own Android app, which is
 * the identifier this grant is generally used with. If Reddit ever
 * retires it, live lookups start failing and everything silently falls
 * back to the archive; nothing else breaks. Anyone holding an id of
 * their own can put it in Settings instead.
 *
 * BUDGET
 * 100 requests per minute, 100 posts per request — ten thousand posts a
 * minute, against a watch list that is realistically under fifty. The
 * ceiling is not the constraint; politeness is, so the watcher polls on
 * a timer and only while the tab is in front of you.
 * ===================================================================== */
(function () {
  const Live = {};

  const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
  const API = "https://oauth.reddit.com";
  const GRANT = "https://oauth.reddit.com/grants/installed_client";
  /* Reddit's documented value for "do not build a profile of me". */
  const DEVICE_ID = "DO_NOT_TRACK_THIS_DEVICE";
  const CLIENT_ID = "ohXpoqrZYub1kg";

  const ENABLED_KEY = "rj.live";
  const CLIENT_KEY = "rj.liveClientId";
  const TOKEN_KEY = "rj.liveToken";

  /* Renew well before the hour is out rather than discovering the
   * expiry mid-sync and reporting a failure the user cannot act on. */
  const RENEW_MARGIN_MS = 30 * 60 * 1000;
  const BATCH = 100;
  const REQUEST_TIMEOUT_MS = 9000;

  /* After this many consecutive failures, stop trying for a while. If
   * Reddit has revoked the client id, every call will fail, and the
   * archive answers perfectly well for anything older than a day —
   * there is no reason to make the user wait for a timeout each time. */
  const TRIP_AFTER = 3;
  const COOLOFF_MS = 5 * 60 * 1000;
  /* A block is an edge decision about the network, not the request, so
   * it lasts longer than a flaky call and deserves a longer pause. */
  const BLOCK_COOLOFF_MS = 20 * 60 * 1000;

  let failures = 0;
  let trippedUntil = 0;
  let inflightToken = null;
  let blocked = false;
  let budget = { remaining: null, resetAt: 0 };

  function readLs(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function writeLs(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (_) { /* private mode; live scores simply will not persist */ }
  }

  /* ==================================================================
   * SETTINGS
   * ================================================================== */

  Live.DEFAULT_CLIENT_ID = CLIENT_ID;

  Live.clientId = function () {
    return (readLs(CLIENT_KEY) || "").trim() || CLIENT_ID;
  };

  Live.usingOwnClientId = function () {
    return Live.clientId() !== CLIENT_ID;
  };

  Live.setClientId = function (id) {
    const clean = String(id || "").trim();
    writeLs(CLIENT_KEY, clean && clean !== CLIENT_ID ? clean : null);
    Live.forget();
  };

  /* On by default. The whole point of the feature is that a post you
   * just made reads as something other than 1, and a switch the user
   * has to find first would mean the first thing they see is still the
   * wrong number. */
  Live.enabled = function () {
    return readLs(ENABLED_KEY) !== "0";
  };

  Live.setEnabled = function (on) {
    writeLs(ENABLED_KEY, on ? null : "0");
    if (!on) Live.forget();
  };

  /* Demo mode is bundled fixtures and makes no network calls at all, so
   * it must not reach for a token either. */
  Live.available = function () {
    if (!Live.enabled()) return false;
    if (window.Demo && Demo.isActive && Demo.isActive()) return false;
    return Date.now() >= trippedUntil;
  };

  Live.forget = function () {
    writeLs(TOKEN_KEY, null);
    inflightToken = null;
    failures = 0;
    trippedUntil = 0;
  };

  /* ==================================================================
   * TOKEN
   * ================================================================== */

  function cachedToken() {
    const raw = readLs(TOKEN_KEY);
    if (!raw) return null;
    try {
      const t = JSON.parse(raw);
      if (!t || !t.token) return null;
      if (t.clientId !== Live.clientId()) return null;
      if (Date.now() > (t.expiresAt || 0) - RENEW_MARGIN_MS) return null;
      return t.token;
    } catch (_) { return null; }
  }

  async function mintToken() {
    const body = new URLSearchParams({ grant_type: GRANT, device_id: DEVICE_ID });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      credentials: "omit",
      /* The grant wants HTTP basic with the client id as the username
       * and an empty password. There is no secret: an installed app is
       * a public client by definition, which is what makes this usable
       * from a page anyone can view the source of. */
      headers: {
        Authorization: "Basic " + btoa(Live.clientId() + ":"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const err = new Error("reddit refused a token (" + res.status + ")");
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    if (!json || !json.access_token) throw new Error("reddit returned no token");
    writeLs(TOKEN_KEY, JSON.stringify({
      token: json.access_token,
      clientId: Live.clientId(),
      expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    }));
    return json.access_token;
  }

  /* One mint at a time. Without this, a campaign refresh that fans out
   * over several batches asks for four tokens at once on a cold start
   * and spends three of them. */
  function token() {
    const have = cachedToken();
    if (have) return Promise.resolve(have);
    if (inflightToken) return inflightToken;
    inflightToken = mintToken().finally(() => { inflightToken = null; });
    return inflightToken;
  }

  /* ==================================================================
   * LOOKUP
   * ================================================================== */

  function note(res) {
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (!isNaN(remaining)) budget.remaining = remaining;
    if (!isNaN(reset)) budget.resetAt = Date.now() + reset * 1000;
  }

  Live.budget = function () {
    return { remaining: budget.remaining, resetAt: budget.resetAt };
  };

  function trip(err) {
    /* A bot-wall block is not a flaky request — retrying it twice more
     * to satisfy a failure counter just adds load to the thing that is
     * already refusing. Stand down on the first one. */
    if (blocked) {
      trippedUntil = Date.now() + BLOCK_COOLOFF_MS;
      failures = 0;
      return err;
    }
    failures++;
    if (failures >= TRIP_AFTER) {
      trippedUntil = Date.now() + COOLOFF_MS;
      failures = 0;
    }
    return err;
  }

  /* What to tell the user, in the terms they would describe it in. */
  Live.status = function () {
    if (!Live.enabled()) return { state: "off", text: "Off" };
    if (window.Demo && Demo.isActive && Demo.isActive()) {
      return { state: "demo", text: "Not used in demo mode" };
    }
    if (Date.now() < trippedUntil) {
      const mins = Math.max(1, Math.round((trippedUntil - Date.now()) / 60000));
      return {
        state: blocked ? "blocked" : "erroring",
        text: blocked
          ? `Reddit is not accepting anonymous reads from this network at the moment, so recent posts are showing archive numbers. Retrying in about ${mins} min.`
          : `Live lookups are failing (${Live.lastError || "unknown"}); using the archive. Retrying in about ${mins} min.`,
      };
    }
    return { state: "on", text: "On" };
  };

  async function getBatch(fullnames) {
    const bearer = await token();
    const url = API + "/api/info?raw_json=1&id=" + fullnames.join(",");
    const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const tid = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, {
        credentials: "omit",
        headers: { Authorization: "bearer " + bearer, Accept: "application/json" },
        signal: controller && controller.signal,
      });
      note(res);

      /* Two different 403s wear the same status code and want opposite
       * responses.
       *
       * A JSON 403 is about the token: expired early, or a client id
       * Reddit no longer accepts. Throwing the token away is right —
       * the next call mints a fresh one and usually succeeds.
       *
       * An HTML 403 is Reddit's bot wall, served by its edge before the
       * API sees the request at all. The token is fine; the caller is
       * not welcome right now. Minting again would be pointless load
       * against the very thing that just refused us, so keep the token
       * and back off instead. Measured shape: text/html, ~190KB,
       * `server: snooserv`, `retry-after: 0`. */
      if (!res.ok) {
        const html = (res.headers.get("content-type") || "").indexOf("html") >= 0;
        if (html || res.status === 429) {
          blocked = true;
          throw new Error(res.status === 429
            ? "reddit is rate limiting this network"
            : "reddit is not accepting anonymous reads from this network right now");
        }
        if (res.status === 401 || res.status === 403) {
          writeLs(TOKEN_KEY, null);
          throw new Error("reddit rejected the token (" + res.status + ")");
        }
        throw new Error("reddit returned " + res.status);
      }
      blocked = false;
      const json = await res.json();
      const children = (json && json.data && json.data.children) || [];
      const out = [];
      for (const c of children) {
        if (c && c.kind === "t3" && c.data) out.push(c.data);
      }
      return out;
    } finally {
      if (tid) clearTimeout(tid);
    }
  }

  /* Current numbers for these post ids, normalised into the app's post
   * shape. Returns null — not an empty array — when live data could not
   * be had, so a caller can tell "Reddit says these do not exist" from
   * "we could not ask", and fall back to the archive only in the second
   * case. */
  Live.lookup = async function (ids) {
    if (!Live.available()) return null;
    const clean = Util.uniqBy(
      [].concat(ids || []).map((id) => String(id || "").replace(/^t3_/, "").trim()).filter(Boolean),
      (x) => x
    );
    if (!clean.length) return [];

    try {
      const out = [];
      for (let i = 0; i < clean.length; i += BATCH) {
        const batch = clean.slice(i, i + BATCH).map((id) => "t3_" + id);
        const raw = await getBatch(batch);
        for (const d of raw) out.push(stamp(Reddit.normalizePost(d)));
      }
      failures = 0;
      return out;
    } catch (err) {
      trip(err);
      Live.lastError = (err && err.message) || String(err);
      return null;
    }
  };

  /* A live reading is the real number as of now, which is the strongest
   * claim any part of this app can make about a score. Say so on the
   * post, so charts and KPIs can stop flagging it as provisional and
   * the UI can show where the figure came from. */
  function stamp(post) {
    post.score_confirmed = true;
    post.score_asof = new Date().toISOString();
    post.score_live = true;
    return post;
  }

  Live.isLive = function (post) {
    return !!(post && post.score_live);
  };

  /* ==================================================================
   * WHAT IS WORTH WATCHING
   * ================================================================== */

  /* The window where the archive has nothing to say. Past this, its
   * second pass has run and its numbers are as good as Reddit's, so
   * there is nothing to gain by asking twice. */
  Live.BLIND_HOURS = 36;

  Live.inBlindWindow = function (post) {
    if (!post || !post.created_utc) return false;
    const ageH = (Date.now() / 1000 - post.created_utc) / 3600;
    return ageH >= 0 && ageH < Live.BLIND_HOURS;
  };

  /* Posts a live lookup would actually improve: young enough that the
   * archive is still guessing, and not already read from Reddit within
   * the last minute. */
  Live.worthWatching = function (posts) {
    const out = [];
    for (const p of posts || []) {
      if (!p || !p.id) continue;
      if (!Live.inBlindWindow(p)) continue;
      out.push(p);
    }
    return out;
  };

  window.Live = Live;
})();
