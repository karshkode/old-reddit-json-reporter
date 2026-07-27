/* =====================================================================
 * Reddit JSON CORS proxy — Cloudflare Worker
 * =====================================================================
 *
 * WHY THIS EXISTS
 *
 *   Reddit blocks every datacenter IP for unauthenticated JSON fetches —
 *   you get a 403 + "Blocked due to a network policy" page. The popular
 *   public CORS proxies (codetabs, allorigins, corsproxy.io, etc.) all
 *   forward through datacenter IPs and are now blocked too.
 *
 *   Cloudflare Workers used to be the way around that, because Reddit
 *   allowed traffic from Cloudflare's edge. AS OF 2026-07 THAT IS NO
 *   LONGER TRUE: a worker built from this file returns Reddit's 403
 *   block page for every content endpoint, and no User-Agent value
 *   changes that — the decision is made on the IP, before the request
 *   reaches an application server. The one reddit.com endpoint that
 *   still answers is POST /api/v1/access_token, i.e. Reddit expects you
 *   to register an app and use OAuth.
 *
 *   See SETUP.md for the measurements and for the two ways forward:
 *   the dashboard's built-in Reddit archive source (no worker, no
 *   account), or OAuth with a registered app.
 *
 * WHAT THIS WORKER DOES
 *
 *   1. Accepts requests like
 *        GET  https://<your-worker>.workers.dev/?url=<encoded-reddit-url>
 *        GET  https://<your-worker>.workers.dev/?ping
 *   2. Verifies the target host is on the reddit.com allowlist below.
 *      (NOT an open relay — only Reddit URLs are forwarded.)
 *   3. Fetches the target with a unique User-Agent.
 *   4. Returns the response with Access-Control-Allow-Origin: *
 *      so a browser fetch from your dashboard won't get CORS-blocked.
 *   5. Caches **only successful** responses on Cloudflare's edge for 5
 *      minutes. Errors (429, 4xx, 5xx, and Reddit's block-page) are
 *      NEVER cached — see the rate-limit recovery note below.
 *
 * USAGE FROM THE DASHBOARD
 *
 *   1. Deploy this worker (see cloudflare-worker/SETUP.md).
 *   2. Copy the worker URL Cloudflare gives you.
 *      Example: https://reddit-proxy.alex.workers.dev
 *   3. In the dashboard's topbar:  Data source ▾  →  Custom (your CORS proxy)
 *   4. Paste your worker URL into the input that appears.
 *   5. Tap Go / Refresh.
 *
 *   Verify by opening
 *     https://<your-worker>.workers.dev/?ping
 *   in a browser — it should show {"ok":true,"version":"…"} immediately.
 *
 * RATE-LIMIT RECOVERY (the bug v1 had)
 *
 *   v1 of this worker used `cf.cacheTtl: 60` + `cacheEverything: true`,
 *   which cached EVERY upstream response for 60 seconds — including
 *   Reddit's 429 "rate limited" responses and 403 "Blocked due to a
 *   network policy" pages. Once Reddit returned an error once, the
 *   dashboard saw cached errors for the next 60 seconds, the
 *   circuit breaker tripped, and the user was stuck.
 *
 *   v2 (this file) uses `cacheTtlByStatus` so only 2xx responses are
 *   cached. 4xx and 5xx are never cached. Recovery is immediate as
 *   soon as Reddit's transient block lifts.
 *
 * COST
 *
 *   Free tier: 100,000 requests/day. With 5-minute edge caching,
 *   refreshing a 6-subreddit dashboard every minute uses ~1,200
 *   requests/day — well under the limit. No credit card required.
 *
 * SECURITY
 *
 *   - ALLOWED_HOSTS hard-codes the only origins this worker will
 *     forward to. You cannot turn this into a generic open proxy.
 *   - HTTPS-only target URLs.
 *   - GET / HEAD only. No body forwarding, no cookie passthrough.
 *   - The worker URL is public, but since it only proxies reddit.com,
 *     anyone who finds it can only use it to read public Reddit JSON —
 *     same as a regular browser request.
 *
 * ===================================================================== */

const VERSION = "v2.1";

const ALLOWED_HOSTS = new Set([
  "www.reddit.com",
  "old.reddit.com",
  "api.reddit.com",
  "oauth.reddit.com",
  "i.redd.it",
  "v.redd.it",
]);

/* Identify your deployment. Reddit's API guidelines ask for a
 * user-agent shaped roughly like
 *   <platform>:<app id>:<version> (by /u/<username>)
 * A unique value is the most important factor in not being lumped
 * with abusive scrapers. Customize the / version / username below. */
const USER_AGENT = "web:reddit-campaign-reporter:v2.0 (by Cloudflare Worker proxy)";

/* Edge cache window for SUCCESSFUL responses only. 300s = 5 min.
 * Reddit listings change slowly enough that 5 minutes is invisible
 * to humans but cuts your worker request count drastically when
 * multiple users hit the same URL. Errors are never cached. */
const SUCCESS_CACHE_SECONDS = 300;

export default {
  async fetch(request, env, ctx) {
    /* --- CORS preflight --- */
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    /* --- Method allowlist --- */
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse(405, { error: 405, message: "Only GET / HEAD allowed" });
    }

    const url = new URL(request.url);

    /* --- Health check / version probe ---
     * Useful for verifying the worker is reachable before you start
     * burning through Reddit fetches. The dashboard's "Test proxy"
     * button (if present) hits this endpoint. */
    if (url.searchParams.has("ping")) {
      return jsonResponse(200, {
        ok: true,
        version: VERSION,
        worker: "reddit-proxy",
        time: new Date().toISOString(),
      }, { cache: false });
    }

    /* --- Pull and validate the target URL ---
     *
     * Two formats supported:
     *
     *   1. Query-string (preferred, what the dashboard sends):
     *        /?url=<encoded reddit URL>
     *
     *   2. Path-based fallback (codetabs-style, defensive):
     *        /<full reddit URL>
     *      e.g. /https://www.reddit.com/r/50501/hot.json
     *
     * (2) catches users whose proxy-URL paste had a trailing slash,
     *     which made the dashboard's customBuild emit
     *     `https://worker/https://www.reddit.com/...` instead of
     *     `https://worker/?url=...`. Without this fallback every
     *     such request returned 400 "Missing ?url=" and the
     *     dashboard's circuit-breaker would compound the failure.
     */
    let targetParam = url.searchParams.get("url");
    if (!targetParam) {
      const pathMatch = url.pathname.match(/^\/(https?:\/\/.+)$/);
      if (pathMatch) {
        /* Re-attach any query string the dashboard appended to the
         * Reddit URL (raw_json=1 etc.). url.search includes the
         * leading "?" or is empty. */
        targetParam = pathMatch[1] + url.search;
      }
    }
    if (!targetParam) {
      return jsonResponse(400, {
        error: 400,
        message: "Missing target URL. Pass it as ?url=<encoded reddit URL> or as a /<full reddit URL> path.",
        examples: [
          "/?url=https%3A%2F%2Fwww.reddit.com%2Fr%2F50501%2Fhot.json",
          "/https://www.reddit.com/r/50501/hot.json",
          "/?ping",
        ],
        worker: VERSION,
      });
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetParam);
    } catch (_) {
      return jsonResponse(400, { error: 400, message: "Invalid ?url= parameter — not a valid URL." });
    }

    if (targetUrl.protocol !== "https:") {
      return jsonResponse(400, { error: 400, message: "HTTPS only." });
    }

    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return jsonResponse(403, {
        error: 403,
        message: "This worker only proxies reddit.com. Got: " + targetUrl.hostname,
      });
    }

    /* --- Forward to Reddit ---
     *
     * `cacheTtlByStatus` is the critical setting. With the previous
     * `cacheTtl: 60` + `cacheEverything: true`, Cloudflare cached
     * EVERY response for 60s including 429s and Reddit's block-page,
     * leaving the dashboard stuck in a failure loop. Per-status TTL
     * means errors are never cached and the recovery from a
     * transient Reddit hiccup is instant. */
    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json,*/*;q=0.5",
          "Accept-Language": "en-US,en;q=0.5",
        },
        cf: {
          cacheTtlByStatus: {
            "200-299": SUCCESS_CACHE_SECONDS,
            /* Reddit sometimes returns 301 to a different
             * canonical URL — cache briefly so we don't follow
             * the redirect on every refresh. */
            "301-399": 60,
            /* Never cache anything that smells like an error.
             * The whole point of this rewrite. */
            "400-499": 0,
            "500-599": 0,
          },
          cacheEverything: true,
        },
      });
    } catch (err) {
      return jsonResponse(502, {
        error: 502,
        message: "Upstream fetch to Reddit failed: " + (err && err.message || err),
      });
    }

    /* --- Detect Reddit's block-page (200 + non-JSON HTML) ---
     *
     * Reddit's anti-bot wall sometimes serves a "Blocked due to a
     * network policy" HTML page with a 200 status. Without this
     * branch, our worker would forward the HTML as if it were valid
     * JSON, the 200 would be CACHED for 5 minutes, and the dashboard
     * would parse-error every refresh until expiry.
     *
     * Convert to a 503 + structured payload. Per cacheTtlByStatus,
     * 5xx is never cached, so retries can recover instantly when
     * Reddit lifts the block. */
    const contentType = upstream.headers.get("Content-Type") || "";
    if (
      upstream.status === 200 &&
      !contentType.toLowerCase().includes("json") &&
      !targetUrl.hostname.startsWith("i.") &&
      !targetUrl.hostname.startsWith("v.")
    ) {
      const sniff = (await upstream.text()).slice(0, 400);
      return jsonResponse(503, {
        error: 503,
        message: "Reddit returned a non-JSON response (likely a block page or maintenance HTML).",
        upstreamStatus: 200,
        upstreamContentType: contentType,
        upstreamSnippet: sniff,
        hint: "Reddit blocks unauthenticated reads from datacenter IPs, which includes Cloudflare Workers. This is not transient and changing USER_AGENT does not help. Switch the dashboard to Settings -> Data source -> Reddit archive, or register a Reddit app and use OAuth. See cloudflare-worker/SETUP.md.",
      });
    }

    /* --- Mirror status + body, swap headers for CORS friendliness ---
     *
     * Cache-Control on the RESPONSE is what the user's browser
     * (and any intermediate caches) honors. We mirror the
     * cacheTtlByStatus policy: cache successes for 5 min, never
     * cache errors. */
    const respHeaders = new Headers(corsHeaders());
    respHeaders.set("Content-Type", contentType || "application/json; charset=utf-8");
    respHeaders.set("X-Reddit-Status", String(upstream.status));
    respHeaders.set("X-Worker-Version", VERSION);

    if (upstream.status >= 200 && upstream.status < 300) {
      respHeaders.set(
        "Cache-Control",
        `public, max-age=${SUCCESS_CACHE_SECONDS}, s-maxage=${SUCCESS_CACHE_SECONDS}`
      );
    } else {
      /* IMPORTANT: no-store, not just no-cache.
       *   - no-cache: revalidate before reuse (still cached).
       *   - no-store: don't write to any cache, including disk.
       * The whole point is to avoid the dashboard re-reading a
       * stale 429 / 403 / 5xx from any layer of cache. */
      respHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      respHeaders.set("Pragma", "no-cache");
    }

    /* Pass through Reddit's Retry-After header on 429 so a smart
     * client (the dashboard's circuit breaker) can wait the exact
     * duration before retrying instead of guessing. */
    const retryAfter = upstream.headers.get("Retry-After");
    if (retryAfter) respHeaders.set("Retry-After", retryAfter);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Access-Control-Expose-Headers": "X-Reddit-Status, X-Worker-Version, Retry-After",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(status, payload, options) {
  options = options || {};
  const headers = {
    ...corsHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "X-Worker-Version": VERSION,
  };
  if (options.cache === false || status >= 400) {
    headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
    headers["Pragma"] = "no-cache";
  }
  return new Response(JSON.stringify(payload), { status, headers });
}
