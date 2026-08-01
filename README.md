# Reddit Campaign Reporter

> A zero-backend dashboard for measuring how a message lands when you
> deliberately post it across several subreddits at once — trend analysis
> per community, campaign tracking across them, and a discovery engine
> that tells you which other communities are worth the next post.

[![Live demo](https://img.shields.io/badge/live%20demo-karshkode.github.io-ff5722?style=flat-square)](https://karshkode.github.io/old-reddit-json-reporter/?demo=1)
[![No backend](https://img.shields.io/badge/backend-none-blue?style=flat-square)](#how-it-works)
[![GitHub Pages](https://img.shields.io/badge/host-GitHub%20Pages-181717?style=flat-square&logo=github)](https://pages.github.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](#license)

A static site: no server, no build step, no API key, no account.
Everything runs in your browser. Campaigns and preferences live in
`localStorage`; the post cache and the subreddit index live in
IndexedDB. Add `?demo=1` to the URL to explore the whole thing on
bundled sample data without touching the network.

---

## Table of contents

- [Where the data comes from](#where-the-data-comes-from)
- [The four views](#the-four-views)
  - [Dashboard](#dashboard)
  - [Campaigns](#campaigns)
  - [Communities](#communities)
  - [Posts](#posts)
- [How discovery works](#how-discovery-works)
- [Demo mode](#demo-mode)
- [Cross-device session sync](#cross-device-session-sync)
- [How it works](#how-it-works)
- [Run locally](#run-locally)
- [Deploy to GitHub Pages](#deploy-to-github-pages)
- [File layout](#file-layout)
- [Notes on accuracy](#notes-on-accuracy)
- [License](#license)

---

## Where the data comes from

Reddit's `/json` endpoints send no `Access-Control-Allow-Origin` header,
so a page on `*.github.io` cannot fetch them directly. The usual answer
is a CORS proxy — and as of mid-2026 that answer no longer works.
Reddit returns `403 Blocked due to a network policy` to every
unauthenticated request from a datacenter IP address, which is what
every public proxy is, and what a Cloudflare Worker of your own is too.
Changing the User-Agent does not help; the block is decided before the
request reaches an application server.

So the default source is not a proxy at all. **Arctic Shift** is a
public Reddit archive that serves plain JSON with CORS headers, which
means your browser reads it directly — nothing to deploy, nothing to
sign up for. `js/archive.js` translates its API into the shape Reddit's
own JSON has, so everything downstream is unchanged.

What you give up by reading an archive:

| | |
|---|---|
| **Scores lag** | A post is archived within minutes of submission with whatever score it had then, usually 1. A re-scan records the real numbers about a day later. *Hot* and *Top* show only posts whose scores have settled; *New* shows everything and marks the unsettled rows. |
| **No true ranking** | The archive orders by time, not by Reddit's hot algorithm, so *Hot* and *Top* are approximated by pulling the requested window and sorting by score. Deterministic, which Reddit's ranking is not. |
| **No site-wide search** | Free-text search must be scoped to a subreddit or an author, so discovery's "mine recent top posts across Reddit" phase is skipped rather than faked. |

The proxy chain is still in **Settings → Data source** and still tried
in auto mode, because a proxy that does get through returns live
scores. If you want live scores reliably, the supported path is
registering a Reddit app and using OAuth —
`POST /api/v1/access_token` is the one Reddit endpoint still reachable
from a datacenter. See [`cloudflare-worker/SETUP.md`](cloudflare-worker/SETUP.md)
for the measurements behind all of this.

---

## The four views

The shell is a nav rail on desktop, a tab bar on phones. Each view
renders lazily and is invalidated when the data behind it changes, so
switching views is instant and nothing recomputes that nobody is
looking at.

### Dashboard

Everything about the currently loaded set of subreddits, as one page.

- **KPI row** — posts, upvotes, comments, average upvote ratio, best
  posting hour in your local timezone with the lift over average, and
  the top-scoring post.
- **When posts go up** — a full-width timeline. Switch between *Per
  sub*, *Stacked*, *Density* (each sub normalised to its own peak, so
  cadence shapes overlay without volume bias) and *Total*, across
  windows from 1 day to all time. Bucket size follows the window.
- **Best hours** and **busiest days**, **score vs comments**,
  **side-by-side subreddit totals**, a **score histogram**, a
  **sentiment doughnut** and **recent-post velocity**.
- **Words coming up most**, **quick takeaways** in plain English, and
  **topics that keep coming up** — recurring themes with sentiment,
  engagement, cross-sub spread and clickable examples.
- **What each subreddit looks like** — an audience fingerprint per sub:
  engagement style, reception, best hour, top themes.
- **The same post in multiple subreddits** — cross-post detection across
  your loaded data, ranked by spread first and score second, so a post
  seeded into five subs outranks a single viral hit.

### Campaigns

A campaign is a set of post IDs you are tracking together, usually the
same message cross-posted to several communities.

The list view shows every campaign as a tile with goal progress, plus a
14-day calendar strip and a two-campaign comparison. Opening one gives
you a workspace with six sections:

| Section | What is in it |
|---|---|
| **Overview** | KPI row, goal bars, campaign-scoped charts |
| **Subreddits** | A trend card per community the campaign reached, with its own cadence and posting-hour charts, plus a cross-sub comparison chart and table. When a sub has too few campaign posts to chart honestly, the card shows that sub's own posting rhythm instead and says how the campaign's timing compares. |
| **Posts** | Every tracked post, with paste-to-add and per-row removal |
| **Targeting** | Discovery — see below — plus a ranking of the subs already in your dashboard by how well they fit this campaign |
| **Plan** | Cross-post cascade scheduling, title prediction and rewriting, volunteer coverage |
| **Settings** | Goals, digest export, delete |

Adding posts accepts anything pasteable from a phone: full URLs, mobile
share links (`/r/x/s/<token>`, resolved automatically), `redd.it` short
URLs, `t3_…` fullnames, or bare IDs. A live chip preview shows what got
recognised before you commit.

### Communities

Where subreddits come from. Three tabs:

- **Search** — type-ahead over Reddit's subreddit search, the curated
  catalog and your local index, so results appear instantly offline and
  upgrade when the network answers. Each result can expand into its
  **similar communities**, derived from four independent signals with
  the contributing ones named.
- **Sphere catalog** — 13 progressive issue spheres, 51 state spheres
  (50 states plus DC), 6 audience spheres, 318 subreddits in total. Load
  a whole sphere, pick individual subs out of one, or take a starter
  bundle (*Progressive core*, *Movement & direct action*, *Economic
  justice*, *Civil rights*, *Climate*).
- **Loaded subs** — what is currently in the dashboard, with per-sub
  removal.

### Posts

A sortable, paginated table of every loaded post with per-view sub
filtering, title/author/flair search, and post-ID filtering. Tapping a
row opens a detail panel: top comments with sentiment, thread
temperature, upvote ratio, permalink, and a title-quality score broken
down by factor (length, caps ratio, punctuation, numerals, brackets,
sentiment, clickbait).

---

## How discovery works

Discovery answers "which other communities should this campaign be
posting in". Both sides of the comparison become weighted term vectors,
compared by inverse-document-frequency-weighted cosine similarity:

- the **campaign vector** from post titles, flair, and the subs it
  already posted in;
- the **subreddit vector** from display name (×3), title (×2) and
  public description (×1), stemmed and stopword-filtered.

This replaced substring counting, which matched `vote` inside `devoted`,
gave no credit for related-but-differently-spelled vocabulary, and could
not explain a match beyond echoing the keyword back.

The curated spheres in `js/seeds.js` are **ranked, not detected**. Each
sphere gets its own vector — built from its label, its trigger
vocabulary and the real descriptions of its members — and every sphere
is scored with a confidence. A housing campaign surfaces the tenancy
sphere because the vocabulary matches, not because someone remembered
to add "eviction" to a list. The spheres that scored appear as chips
with their confidence; clicking one pins it so it seeds later runs too.

A run has five phases:

1. **Multi-angle search** — the campaign's vocabulary is split into
   several narrow queries rather than one broad one, and a sub matching
   more than one of them is a stronger signal than a sub matching the
   biggest.
2. **Post mining** — recent top posts on the campaign's keywords, to
   find active communities that subreddit search never surfaces.
   Skipped when the archive is the live source, since it cannot serve a
   site-wide search.
3. **Sphere seeding** — every member of every sphere that scored.
4. **Description resolution** — `about.json` for every name in play,
   cached in IndexedDB for 30 days, so description matching is based on
   descriptions actually read and a second run is nearly free.
5. **Scoring** — theme, sphere fit, civic-space fit, engagement, reach,
   search and post-mining hits, minus an off-topic penalty and a
   discount for mega-subs that match any vocabulary by sheer surface
   area.

Each candidate carries reasoning that names the overlapping words rather
than restating its score, so you can tell a real match from a
coincidence. The **Relevant / All** toggle re-filters the scored list in
place — no refetch, no waiting.

---

## Demo mode

Append `?demo=1` to load a bundled fixture dataset: 183 posts across 12
subreddits, two campaigns built from real cross-post groups, and enough
seeded subreddit metadata that search and discovery work offline.
Nothing is fetched and nothing is written to your device. Useful for
evaluating the tool, for screenshots, and for reproducing bugs without
depending on whether Reddit is answering today.

---

## Cross-device session sync

State lives per-device in `localStorage`. To move it, **Sync session**
offers four backend-free flows:

| Action | What it does |
|---|---|
| **Copy share link** | A `https://…/#session=<base64>` URL. The fragment never hits the network, so paste lists stay private. |
| **Download JSON** | A dated `.json` file with the full payload. |
| **Copy JSON** | The same payload to the clipboard, for Universal Clipboard or a chat app. |
| **Import…** | Paste a link, paste JSON, or pick a file — the shape is auto-detected. **Merge** keeps existing campaigns and adds new ones, deduped by id or by `(name, postIds)`; **Replace** wipes first. |

Opening a `#session=…` link on another device shows a banner offering
*Merge / Replace / Dismiss* before anything is touched, then strips the
fragment so a reload does not re-prompt.

Synced: campaigns, known and active subs, pinned spheres, and fetch
preferences. Not synced: per-device viewing state like sort order, page
index and current view.

---

## How it works

### Performance and resilience

- Parallel multi-sub fetching at concurrency 3, with the
  most-recently-successful transport bubbled to the front of the next
  request.
- Streaming progress that advances per page of results, not per
  subreddit.
- A cancellation token, so re-tapping Refresh mid-flight discards the
  older batch instead of interleaving it.
- Light vs full re-render split: incremental updates during streaming
  touch only the KPI row and the table; charts and profiles rebuild once
  at the end.
- Per-ID fallback when a batch `/by_id/` lookup is refused.
- Local-first campaign aggregation — IDs already present in loaded data
  resolve with no network at all, painting instantly and filling in
  after.
- Five-minute request cache with stale-while-revalidate, exponential
  backoff on 429, and an IndexedDB post cache that survives reloads.
- Every startup step is isolated, so one failure cannot take down the
  rest of the boot.

### Modules

| Module | What it provides |
|---|---|
| `js/state.js` | The single app state object and its persistence |
| `js/router.js` | View registry, lazy mount, hash routing, invalidation |
| `js/dom.js` | Small DOM helpers: query, fill, delegate, empty states, skeletons |
| `js/theme.js` | Explicit dark/light/system switching, applied before first paint |
| `js/util.js` | Formatters, ID and share-URL parsing, concurrency-limited `pmap`, toasts, progress |
| `js/archive.js` | Arctic Shift adapter — presents an archive as Reddit's JSON API |
| `js/reddit.js` | Transport chain, listing pagination with streaming, batching, search, share-URL resolution |
| `js/postcache.js` | IndexedDB post cache |
| `js/subindex.js` | IndexedDB subreddit index: metadata, derived term vectors, stemming, 30-day TTL |
| `js/seeds.js` | The curated catalog — issue, state and audience spheres, starter bundles |
| `js/analysis.js` | Aggregates, activism-tuned lexicon sentiment, keywords and bigrams, themes, per-sub profiles, campaign profiles, targeting, comment-side analysis, title quality |
| `js/discovery.js` | The discovery pipeline: campaign vectors, sphere ranking, candidate scoring, filtering, similar communities |
| `js/charts.js` | Chart.js wrappers plus dynamic mount/destroy for cards that come and go |
| `js/campaigns.js` | Campaign storage with an in-memory mirror for blocked-storage browsers |
| `js/sync.js` | Session payload, base64url codec, share links, merge/replace |
| `js/composer.js` | Compose-and-cross-post sidebar |
| `js/ui.js` | Shared rendering: KPI row, posts table, post detail, themes, profiles, candidates |
| `js/views/*.js` | One module per view: dashboard, campaign, communities, posts |
| `js/demo.js` | The fixture dataset behind `?demo=1` |
| `js/app.js` | Orchestration, event wiring, data fetching |

---

## Run locally

It is static HTML. Any HTTP server will do:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Add `?demo=1` if you want to look around without hitting the network.

---

## Deploy to GitHub Pages

`.github/workflows/pages.yml` publishes the repository root on every
push to `main`. After the first push:

1. Open the repo's **Settings → Pages**.
2. Set **Source** to **GitHub Actions**.
3. The site appears at `https://<user>.github.io/<repo>/`.

`.nojekyll` is included so `js/` and `css/` are served verbatim.

---

## File layout

```
index.html                 app shell: nav rail, topbar, view containers, overlays
css/tokens.css             design tokens — spacing, type, colour, elevation, themes
css/base.css               element and primitive styles
css/shell.css              rail, topbar, tab bar, sheets, sidebars
css/views.css              per-view layout
css/styles.css             older component styles, still in play
js/                        see the module table above
sw.js                      service worker
vendor/marked.min.js       markdown rendering for post bodies
cloudflare-worker/         a proxy worker, and the measurements showing why it is not enough
.github/workflows/pages.yml
.nojekyll
```

---

## Notes on accuracy

- **Scores from the archive lag.** Recent posts carry provisional
  numbers and are marked as such; anything older than about 48 hours is
  accurate. Ranked listings only include settled scores.
- **Sentiment** is a lexicon scorer tuned for civic vocabulary
  (`organize`, `solidarity`, `oppress`, `betray`). Directional, not
  authoritative.
- **Themes** are keyword and bigram frequency with a stopword filter —
  no language model, no remote AI. A phrase theme that wholly contains a
  single-word theme suppresses the single word.
- **Discovery scores** are cosine similarity over term vectors plus
  named heuristics. Every candidate lists the words and signals behind
  its number, because a fit score you cannot check is not worth much.
- **Awards** are gone: Reddit retired them in 2023 and the fields are
  always zero, so the dashboard drops them rather than charting zeros.
- **`view_count`** is hidden by Reddit from non-owners on most posts.
  The dashboard shows it when present and says so when absent rather
  than inventing a number.

---

## License

[MIT](LICENSE) — do as you like, no warranty.
