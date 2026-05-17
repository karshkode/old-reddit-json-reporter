# Reddit Campaign Reporter

> A zero-backend, GitHub Pages–ready dashboard that scrubs old Reddit's `/json`
> endpoints to power **trend analysis, audience discovery, and cross-post
> campaign tracking** — in the spirit of *redditstats.com* but tuned for
> measuring how a deliberately cross-posted message lands across multiple
> communities at once.

[![Live demo](https://img.shields.io/badge/live%20demo-karshkode.github.io-ff5722?style=flat-square)](https://karshkode.github.io/old-reddit-json-reporter/)
[![No backend](https://img.shields.io/badge/backend-none-blue?style=flat-square)](#how-it-works)
[![GitHub Pages](https://img.shields.io/badge/host-GitHub%20Pages-181717?style=flat-square&logo=github)](https://pages.github.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](#license)

A static site — no server, no API key, no account. Everything happens in
your browser; campaigns and preferences live in `localStorage`. Default
subreddits ship as **r/Political_Revolution** and **r/50501**, easily
swapped at runtime.

---

## Table of contents

- [What it does](#what-it-does)
  - [Overview tab](#overview-tab)
  - [Trends tab](#trends-tab)
  - [Posts tab](#posts-tab)
  - [Campaigns tab](#campaigns-tab) — Discover audiences, track cross-posts, cross-post submit links
- [Cross-device session sync](#cross-device-session-sync)
- [How it works](#how-it-works)
- [Run locally](#run-locally)
- [Deploy to GitHub Pages](#deploy-to-github-pages)
- [File layout](#file-layout)
- [Notes on accuracy](#notes-on-accuracy)
- [License](#license)

---

## What it does

### Overview tab

- **KPI row** at the top: total posts, total upvotes, total comments, average upvote ratio, **best posting hour** (in your local timezone, with the lift over the overall average), top-scoring post.
- **Posts over time** as a full-width chart — switch between *Per sub*, *Stacked area*, *Density* (each sub normalised to its own peak so cadence shapes overlay without volume bias), or *Total*. Time window picker: **1d** (hourly buckets), 3d, 7d, 30d, 90d, All. Bucket size adapts to the chosen window.
- Smaller charts: **Score vs comments** scatter, **Each subreddit, side by side** bar chart, **How well posts did** score-distribution histogram, **Are titles upbeat or critical?** lexicon-sentiment doughnut.
- **Words coming up most** — keyword cloud, stop-word + month/weekday filtered.
- **Quick takeaways** — collapsible auto-generated plain-English suggestions (best posting time, audience reception, score-to-comment ratio, top performers).
- Narrative paragraph at the top reads as a short briefing of the loaded data.

### Trends tab

- **When posts do best** — average upvotes per local hour.
- **Busiest days of the week**.
- **How recent posts are doing** — score & comment velocity for the latest posts.
- **Topics that keep coming up** — recurring themes from titles + flair, each with sentiment + engagement + cross-sub spread + clickable example posts. Phrase themes (`general strike`, `voter registration`, …) are surfaced separately from single-word ones.
- **What each subreddit looks like** — audience fingerprint per loaded sub: engagement style (*shareable* / *discussion* / *mixed*), reception (*warm* / *healthy* / *mixed* / *contentious*), best posting hour, top themes + vocabulary.

### Posts tab

- **Sortable, paginated** post table with per-tab **Sub** filter and **Per page** selector (25/50/100/All).
- **Title + author + flair** search input on the tab itself, two-way bound with the global search.
- **Filter by post ID** — single or comma-separated; works alongside the search.
- Tap a row → **post detail panel**: top comments with sentiment, comment-count summary, upvote ratio, view count if Reddit reports it, full permalink, and a **Title quality** score with a per-factor breakdown (length, caps ratio, question/exclamation, numerals, brackets, sentiment polarity, clickbait).

### Campaigns tab

The hero — Discovery is the primary action, everything else is a tool to support it.

- **Find new subreddits for a campaign** *(hero card)* — pick any saved campaign, hit *Find subreddits*. The engine combines:
  - **Multi-angle Reddit search** — splits the campaign's top phrases + keywords into N parallel queries.
  - **Hot-post mining** — searches `/search.json` for posts that mention the campaign's keywords, then collects the distinct subs those posts live in (this is the lever that surfaces niche communities `/subreddits/search` misses).
  - **Curated sphere catalog** *(`js/seeds.js`)* — 13 progressive-issue spheres (healthcare, voting, labor, climate, reproductive, immigration, education, housing, racial justice, palestine/gaza, …), 50 US states + DC (each with main + city + state-politics subs), 6 demographic spheres (LGBTQ+, women, BIPOC, veterans, etc.).
  - Auto-detection of relevant spheres from the campaign profile, **plus three dropdowns** (`+ Issue` / `+ State` / `+ Audience`) for manual layering. Each chosen sphere's chip shows how many of its subs the engine actually scored, and the average fit, so you can see whether *Veterans* or *Texas* is genuinely pulling its weight.
  - Composite fit score (0–100) based on theme overlap, sentiment alignment, audience reception, posting-time alignment, engagement trend, multi-query frequency, hot-post mentions, and a catalog-membership boost. Reasoning bullets explain *why* a sub ranked where it did.
  - **Relevant** vs **All** toggle — Relevant drops obvious off-topic subs (celebrity / fandom / gaming / mega-generic) and never drops a known catalog member.
  - Two-section render: **New candidates** with full *+ Add to dashboard* and **↪ Cross-post here** actions, and **Already in your dashboard** as a sanity check.
- **↪ Cross-post here** on each candidate — opens Reddit's compose page in that sub pre-filled with the campaign's best-performing post (title + markdown body for self-posts, or URL for link posts). One tap.
- **Saved campaigns** card — every campaign with progress bars; tap to open detail.
- **Start a new campaign** — name, optional goal upvotes / goal comments, and a paste field that accepts **anything pasteable from your phone**: full Reddit URLs, mobile-share `/r/x/s/<token>` links (auto-resolved through the proxy), `redd.it/<id>` short URLs, `t3_…` fullnames, or bare IDs. Live chip preview shows what got recognised.
- **Campaign detail** (when opened): KPI row + goal-progress bars + per-subreddit performance mini-table + **what separates winners from losers** comparison + inline targeting recommendations + **add-more-posts** form + per-post `×` remove buttons + posts list.
- **The same post in multiple subreddits** — cross-post detection across your loaded data. Ranked by **spread first** (number of subs), score second, so a post deliberately seeded into 5 subs ranks above a single viral hit. Tier-coloured row borders (3-4 amber, 5+ green). Tap **+ Make campaign** on any group to instantly track it as a saved campaign.

---

## Cross-device session sync

The dashboard is fully client-side, so campaigns + preferences live in your browser's `localStorage` per device. To move state between devices the *Sync session* panel (in the filter drawer) offers four backend-free flows:

| Action | What it does |
|---|---|
| **📋 Copy share link** | Builds a `https://…/#session=<base64>` URL and copies to clipboard. The fragment after `#` never hits the network — paste lists / IDs stay private. |
| **⤓ Download JSON** | Saves a `reddit-campaign-reporter-session-YYYY-MM-DD.json` file with the full payload pretty-printed. |
| **📋 Copy JSON** | Same JSON to clipboard, for paste-via-iCloud-Universal-Clipboard / iMessage / chat apps without going through Files. |
| **⤴ Import…** | Paste a share link, paste a JSON blob, or pick a file. Auto-detects the input shape. **Merge** keeps existing campaigns and only adds new ones (deduped by id or `(name, postIds)` signature); **Replace** wipes current state first. |

Pasting a `#session=…` URL on another device pops a banner above the dashboard offering *Merge / Replace / Dismiss* before any state is touched. After a click the fragment is stripped from history so a reload doesn't re-prompt.

What gets synced: campaigns (full list with ids, goals, post IDs), `knownSubs` + `activeSubs`, `activeSpheres`, listing/time/limit/transport prefs.
What doesn't: per-device viewing state (table sort, page index, search query, current tab) — would be more annoying than useful.

---

## How it works

### Reddit JSON access

The browser fetches `https://www.reddit.com/r/<sub>/<listing>.json` directly — but Reddit doesn't include `Access-Control-Allow-Origin` on those responses, so a browser running on `*.github.io` can't fetch them straight without help. The dashboard routes requests through a chain of public CORS proxies (codetabs, allorigins, corsproxy.io, isomorphic-git/cors-proxy), validates the response is real Reddit JSON (rejects HTML "Blocked" interstitials and proxy paywall payloads), and falls back to the next proxy if any one is rate-limited or down. Selectable from the **Data source** dropdown.

### Performance & resilience

- **Parallel multi-sub fetching** at concurrency 3 with a sticky-proxy heuristic (the most-recently-successful proxy bubbles to the front of the next request).
- **Streaming progress bar** — fills as each /json page lands, not just when each sub completes. With *Per page = 500* the bar advances ~3 % per page.
- **Cancellation token** — re-tapping Refresh while a batch is mid-flight discards the older batch's results so state doesn't get corrupted.
- **Light vs full re-render split** — incremental updates during streaming touch only the KPI row + posts table; charts/themes/profiles are rebuilt once at the end.
- **Per-ID fallback** — if `/by_id/<list>.json` for a campaign is rate-limited, falls through to per-ID `/comments/<id>.json` lookups.
- **Local-first campaign aggregation** — when opening a campaign, IDs already present in the loaded subreddit data are resolved without any extra network calls. Two-pass render: instant local paint, then a network fill-in.
- **5-minute `sessionStorage` cache** per endpoint, exponential-backoff retries on 429.
- **Robust startup** — every `init()` step is wrapped so a single failure (e.g. Chart.js exploding on an exotic browser) can't take down anything else.

### Analysis (everything client-side)

| Module | What it provides |
|---|---|
| `js/util.js` | formatters, debounce, toast, **`getTzLabel()`** (local timezone), **`parseIdList`** (URL / share-sheet / `t3_` / bare-id), **`parsePostRefs`** (separates clean IDs from share URLs needing async resolution), **`pmap`** (concurrency-limited parallel map) |
| `js/reddit.js` | proxy chain, listing pagination with `onPage` streaming, post-by-id batching, post search, subreddit search, `/r/<sub>/about.json`, share-URL redirect resolver |
| `js/analysis.js` | aggregates, lexicon sentiment (activism-tuned), keyword + bigram extraction, theme clustering, per-subreddit profiles, campaign profile, top-vs-bottom comparison, targeting recommender (theme Jaccard, sentiment match, reception, hour/day alignment, engagement trend slope), title-quality scorer, adaptive time bucketing |
| `js/seeds.js` | curated subreddit catalog (issue spheres, US states + DC, demographics) with auto-detection triggers |
| `js/campaigns.js` | localStorage-backed campaigns with in-memory mirror for iOS Private Browsing / blocked-storage degradation, add/remove post helpers, fromPosts-aware aggregator |
| `js/sync.js` | session payload builder, base64url codec, share-URL composer, payload applier (merge or replace) |
| `js/charts.js` | Chart.js wrappers — timeline (per-sub / stacked / density / total), scatter, bar, histogram, hour heatmap, day-of-week, velocity, sentiment doughnut |
| `js/ui.js` | DOM rendering helpers — KPI row, posts table, post detail, themes, sub profiles, targeting candidates with cross-post links, campaign detail with deep analysis, cross-post groups, pagination control |
| `js/app.js` | state, event wiring, render orchestration |

---

## Run locally

It's static HTML. Any HTTP server will do:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Reddit JSON fetches still go through the CORS-proxy chain — the proxy choice persists across reloads.

---

## Deploy to GitHub Pages

`.github/workflows/pages.yml` deploys the repository root to GitHub Pages on every push to `main`. After the first push:

1. Repo's **Settings → Pages**.
2. Set **Source** to **GitHub Actions**.
3. The workflow publishes the site at `https://<user>.github.io/<repo>/`.

`.nojekyll` is included so `js/` and `css/` are served verbatim.

---

## File layout

```
index.html              shell, KPI row, tabs, controls drawer, campaign forms
css/styles.css          dark + light theme, mobile-first responsive
js/util.js              formatters, parseIdList, parsePostRefs, pmap, getTzLabel, toast
js/sync.js              cross-device session sync (URL link / JSON / merge or replace)
js/reddit.js            proxy-chain JSON fetcher with onPage streaming
js/seeds.js             curated sphere catalog (issues / states / demographics)
js/analysis.js          aggregates, sentiment, themes, profiles, targeting, title quality
js/charts.js            Chart.js wrappers
js/campaigns.js         localStorage-backed campaigns (with private-browsing fallback)
js/ui.js                DOM rendering + pagination helper
js/app.js               orchestrator, state, event wiring
.github/workflows/pages.yml
.nojekyll
```

---

## Notes on accuracy

- **Sentiment** is a lexicon scorer tuned for civic/activist vocabulary (`organize`, `solidarity`, `oppress`, `betray`, …). Treat scores as directional, not authoritative.
- **Theme detection** is keyword + bigram frequency with a stopword filter — no language model, no TF-IDF corpus, no remote AI. Phrase themes that wholly contain a unigram theme suppress the unigram so output isn't noisy.
- **Targeting recommendations** are deterministic pattern recognition: theme Jaccard, sentiment match, audience reception, hour/day cosine alignment, engagement trend, multi-query frequency, hot-post mentions, catalog-membership boost. Reasoning bullets surface every dimension that contributed.
- **Awards** are gone. Reddit deprecated the awards system in mid-2023; the API still ships the fields but they're always 0. The dashboard replaces the *Total awards* KPI with **Best posting hour** and quietly drops the field elsewhere.
- **`view_count`** is hidden by Reddit from non-owner accounts on most posts. The dashboard surfaces the value when present and labels its absence honestly rather than fabricating numbers.
- Reddit may rate-limit aggressive refreshes. The app caches each endpoint for 5 minutes per page load, retries with exponential backoff on `429`s, and bubbles the most-recently-successful proxy to the front of the chain.

---

## License

[MIT](LICENSE) — do as you like, no warranty.
