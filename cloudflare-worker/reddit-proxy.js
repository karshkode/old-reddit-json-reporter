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
 *   Cloudflare Workers run on Cloudflare's edge network. Reddit
 *   historically allows traffic from those IPs, so a personal worker
 *   gives you a stable proxy your dashboard can hit without hitting
 *   Reddit's anti-bot wall.
 *
 * WHAT THIS WORKER DOES
 *
 *   1. Accepts requests like
 *        GET  https://<your-worker>.workers.dev/?url=<encoded-reddit-url>
 *   2. Verifies the target host is on the reddit.com allowlist below.
 *      (NOT an open relay — only Reddit URLs are forwarded.)
 *   3. Fetches the target with a unique User-Agent.
 *   4. Returns the response with Access-Control-Allow-Origin: *
 *      so a browser fetch from your dashboard won't get CORS-blocked.
 *   5. Cloudflare's edge cache holds the response for 60 s, so a Refresh
 *      storm from multiple devices hits Cloudflare, not Reddit.
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
 * COST
 *
 *   Free tier: 100,000 requests/day. A typical campaign-tracking session
 *   uses ~60-200 requests/day, well under the limit. No credit card
 *   required for the free tier.
 *
 * SECURITY
 *
 *   - ALLOWED_HOSTS hard-codes the only origins this worker will forward
 *     to. You cannot turn this into a generic open proxy.
 *   - HTTPS-only target URLs.
 *   - GET / HEAD only. No body forwarding, no cookie passthrough.
 *   - The worker URL is public, but since it only proxies reddit.com,
 *     anyone who finds it can only use it to read public Reddit JSON —
 *     same as a regular browser request.
 *
 * ===================================================================== */

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
const USER_AGENT = "web:reddit-campaign-reporter:v1.0 (by Cloudflare Worker proxy)";

/* Edge cache window. Reddit listings change slowly enough that 60 s
 * of edge caching is invisible to humans but cuts your worker
 * request count drastically when multiple users hit the same URL. */
const EDGE_CACHE_SECONDS = 60;

export default {
  async fetch(request, env, ctx) {
    /* --- CORS preflight --- */
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    /* --- Method allowlist --- */
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonError(405, "Only GET / HEAD allowed");
    }

    /* --- Pull and validate the target URL --- */
    const url = new URL(request.url);
    const targetParam = url.searchParams.get("url");
    if (!targetParam) {
      return jsonError(400, "Missing ?url= parameter. Pass an encoded Reddit JSON URL.");
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetParam);
    } catch (_) {
      return jsonError(400, "Invalid ?url= parameter — not a valid URL.");
    }

    if (targetUrl.protocol !== "https:") {
      return jsonError(400, "HTTPS only.");
    }

    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return jsonError(
        403,
        "This worker only proxies reddit.com. Got: " + targetUrl.hostname
      );
    }

    /* --- Forward to Reddit --- */
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
          /* Cloudflare-specific cache hints. Reddit JSON is cacheable. */
          cacheTtl: EDGE_CACHE_SECONDS,
          cacheEverything: true,
        },
      });
    } catch (err) {
      return jsonError(502, "Upstream fetch to Reddit failed: " + (err && err.message || err));
    }

    /* --- Mirror status + body, swap headers for CORS friendliness --- */
    const respHeaders = new Headers(corsHeaders());
    respHeaders.set(
      "Content-Type",
      upstream.headers.get("Content-Type") || "application/json; charset=utf-8"
    );
    respHeaders.set(
      "Cache-Control",
      `public, max-age=${EDGE_CACHE_SECONDS}, s-maxage=${EDGE_CACHE_SECONDS}`
    );
    /* Surface Reddit's status as a custom header so the dashboard can
     * distinguish proxy errors from upstream Reddit errors. */
    respHeaders.set("X-Reddit-Status", String(upstream.status));

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
    "Access-Control-Max-Age": "86400",
  };
}

function jsonError(status, message) {
  return new Response(
    JSON.stringify({ error: status, message }),
    {
      status,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json; charset=utf-8",
      },
    }
  );
}
