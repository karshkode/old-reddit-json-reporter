# Cloudflare Worker setup — your own Reddit proxy

Reddit blocks every datacenter IP for unauthenticated JSON fetches. The
public CORS proxies the dashboard used to rely on (codetabs, allorigins,
corsproxy.io) all sit on datacenter IPs and have been blocked.

Cloudflare Workers run on Cloudflare's edge, which Reddit historically
allows. Deploying your own worker takes about **3 minutes** and gives
you a stable proxy the dashboard can hit. **No credit card. 100,000
free requests per day.**

---

## What you'll need

- A Cloudflare account ([sign up](https://dash.cloudflare.com/sign-up) — free).
- The file [`reddit-proxy.js`](./reddit-proxy.js) from this repo (~150 lines).

That's it. No CLI, no `wrangler`, no Git. You'll paste the code into
Cloudflare's web editor.

---

## Step-by-step

### 1. Log in to Cloudflare

Go to **<https://dash.cloudflare.com/>** and sign in. The dashboard's
left sidebar shows your account.

### 2. Open the Workers section

In the left sidebar:

- Click **Compute (Workers)** (or just **Workers & Pages** on older UIs).
- If this is your first worker, you'll see a **Get started** button.
  Otherwise click **Create** in the top right.

### 3. Create a new worker

- Click **Create Worker** (or **Hello World**).
- Cloudflare will pick a random name like `purple-frost-1f3b`. You can
  rename it now — something like `reddit-proxy` is clear.
- Click **Deploy** to confirm. Cloudflare creates the worker with the
  default "Hello World" code. We're about to replace that.

### 4. Open the editor

- After deploy, click **Edit code** (top right of the worker page).
- The editor opens with the default Hello World handler.

### 5. Paste the proxy code

- In a separate tab, open [`cloudflare-worker/reddit-proxy.js`](./reddit-proxy.js)
  in this repository. **Copy its entire contents.**
- Back in Cloudflare's editor, **select all** in the code area (Ctrl/⌘+A)
  and **paste** to replace the default code.
- *Optional but recommended:* near the top of the file, edit the
  `USER_AGENT` constant to identify your deployment. Reddit pays
  attention to user-agent strings; a unique one keeps you out of
  generic-bot rate-limit buckets:

  ```js
  const USER_AGENT = "web:reddit-campaign-reporter:v1.0 (by /u/yourname)";
  ```

### 6. Save and deploy

- Top right of the editor: click **Save and Deploy**.
- Confirm. After a few seconds, deployment finishes and the editor
  shows a green "Deployed" indicator.

### 7. Copy your worker URL

- Click the worker's name in the breadcrumb (top left) to go back to
  its overview page.
- The URL is at the top, in the form:

  ```
  https://reddit-proxy.<your-account>.workers.dev
  ```

  Copy it.

### 8. Plug it into the dashboard

- Open the dashboard.
- In the topbar / Filters, find **Data source** and pick **Custom (your
  CORS proxy)**.
- Paste your worker URL into the field that appears.
- Tap **Refresh** (or **Go**) — your fetches now route through your
  worker.

That's it. The dashboard will preferentially use your worker; if it
ever fails, the public proxies are still fallbacks.

---

## Verifying it works

Open this URL in your browser (replace with your worker URL):

```
https://reddit-proxy.<your-account>.workers.dev/?url=https%3A%2F%2Fwww.reddit.com%2Fr%2F50501%2Fhot.json%3Fraw_json%3D1%26limit%3D2
```

You should see Reddit JSON. If you see a `403 Blocked` page, see
**Troubleshooting** below.

---

## Troubleshooting

### "403 Blocked due to a network policy" still in the response

Cloudflare Workers usually bypass this, but Reddit occasionally tightens
their block lists. Things to try in order:

1. **Edit the `USER_AGENT`** in the worker to something more unique (e.g.
   include your Reddit username) and redeploy.
2. **Wait an hour and retry.** Reddit's blocks sometimes lift on their own.
3. **Try the `oauth.reddit.com` host instead of `www.reddit.com`** — it's
   on the allowlist and sometimes returns when `www` doesn't. The
   dashboard sends to `www.reddit.com` by default; you can hard-code a
   rewrite in the worker:

   ```js
   if (targetUrl.hostname === "www.reddit.com") {
     targetUrl.hostname = "oauth.reddit.com";
   }
   ```

   (This works for read-only listing endpoints without authentication.)

### Hit the 100k requests/day limit

Cloudflare's paid Workers plan starts at $5/month for 10 million
requests. For a single user this is unlikely; if you're sharing the
worker URL with a team, consider:

- Increasing `EDGE_CACHE_SECONDS` (e.g. to `300` for 5-minute caching)
  so repeated fetches from teammates hit Cloudflare's cache, not your
  worker quota.

### "Worker isn't responding" / 522 / 524

Cloudflare's edge had a hiccup. Refresh in 30 seconds. If persistent,
check Cloudflare's [status page](https://www.cloudflarestatus.com/).

### Worker is responding but returns weird Reddit data

Reddit might be having a moment (they've been returning 500s
intermittently lately). The dashboard's circuit breaker will detect
this and fast-fail; tap Refresh in a minute.

---

## Customizing further

The worker is intentionally minimal. Reasonable extensions if you have
the patience:

- **Per-IP rate limiting** with Cloudflare's [Rate Limiting Rules](https://developers.cloudflare.com/waf/rate-limiting-rules/).
- **Authentication** — add a shared-secret query param check so only
  people with the secret can use the worker. Useful if you publish the
  worker URL but don't want random scrapers using your quota.
- **Multi-host support** — extend `ALLOWED_HOSTS` if you want to also
  proxy non-Reddit sources (e.g. YouTube oEmbed for thumbnails).

The base file you deployed is enough to keep the dashboard working.
