# Reddit Campaign Reporter

> A zero-backend dashboard for measuring how a message lands when you
> deliberately post it across several subreddits at once — trend analysis
> and posting times per community, campaign tracking across them, and a
> discovery engine that turns any single post into the list of
> communities it belongs in.

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
- [Posting times are per subreddit](#posting-times-are-per-subreddit)
- [From one post to a campaign](#from-one-post-to-a-campaign)
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

The bulk of it is the **[Arctic Shift]** archive, a public mirror of
Reddit that serves plain JSON with CORS headers, so your browser reads
it directly. Nothing to deploy, nothing to sign up for, nothing to
configure. `js/archive.js` translates its API into the shape Reddit's
own JSON has, so everything downstream is unchanged.

Posts under about a day and a half old come from Reddit itself, because
the archive does not yet know anything true about them — see
[Live scores](#live-scores-for-new-posts).

[Arctic Shift]: https://arctic-shift.photon-reddit.com

### Why not Reddit itself, for everything

Reddit's `/json` endpoints send no `Access-Control-Allow-Origin` header,
so a page on `*.github.io` cannot fetch them directly. The usual answer
is a CORS proxy — and as of mid-2026 that answer no longer works. On
**30 May 2026** Reddit closed unauthenticated `.json` access outright:
every one of them now answers `403` to any caller without a token,
including `old.reddit.com`, `api.reddit.com` and the rest. So a proxy
does not help, and neither does a Cloudflare Worker of your own — the
door is shut to the proxy too, not just to you. Changing the User-Agent
does not help either; the block is decided before the request reaches
an application server.

This app used to carry a chain of proxies and fall back through them.
Not one of them could reach Reddit, so the chain's only effect was to
spend half a minute timing out before the archive answered anyway. It
is gone, along with the Data source picker, the proxy-health strip and
the settings that fed them.

### Live scores for new posts

The archive files a post within minutes of submission, at whatever score
it had then — which is 1, because it was submitted a moment ago. A
second pass records the real numbers, but that pass runs roughly
**30 to 36 hours later**. Measured on r/politics: everything under 30
hours old still reads `score=1`, and by 36 hours the real figures are
there. So the archive is excellent for anything older than about a day
and a half, and blind to everything newer — exactly backwards from what
you want just after posting something.

`js/live.js` fills that window by reading those posts from Reddit's own
API. `oauth.reddit.com` is the one surface Reddit still lets a browser
read: it answers with `Access-Control-Allow-Origin: *` and permits the
`Authorization` header, because Reddit built it for browser apps. No
proxy, no worker, no server.

There is nothing to set up and no account involved. The
`installed_client` grant issues an **anonymous, read-only application
token** that lasts a day — no sign-in, no password, and no app to
register. Reddit closed public app registration in 2025, so the
identifier used is the public one belonging to Reddit's own mobile app;
Settings takes your own instead if you ever have one. If Reddit retires
it, live lookups start failing and everything falls back to the archive
on its own.

It is deliberately narrow:

| | |
|---|---|
| **Only the blind window** | Posts under 36 hours old. Past that the archive knows the same numbers, so asking twice buys nothing. |
| **Only while you are looking** | The watcher polls every 90s and stops when the tab is in the background. |
| **Silently optional** | Any failure falls back to the archive. A rate-limited or blocked network costs a stale number, never an error. |
| **Cheap** | 100 posts per request, 100 requests per minute. A realistic watch list is under fifty posts, or one request. |

Other routes were measured and rejected: public CORS proxies are blocked
or erroring on every Reddit URL; `embed.reddit.com` is reachable and
does carry the live score, but only as HTML with no CORS header and
nothing readable from an iframe; RSS is open but carries no scores; and
Pushshift's successor sits behind a Cloudflare challenge.

### What reading an archive costs you

| | |
|---|---|
| **Scores lag** | A post is archived within minutes of submission with whatever score it had then, usually 1. A re-scan records the real numbers about a day and a half later. *Hot* and *Top* show only posts whose scores have settled; *New* shows everything and marks the unsettled rows. [Live scores](#live-scores-for-new-posts) cover the gap for posts you are actually watching. |
| **No true ranking** | The archive orders by time, not by Reddit's hot algorithm, so *Hot* and *Top* are approximated by pulling the requested window and sorting by score. Deterministic, which Reddit's ranking is not. |
| **No site-wide search** | Free-text search must be scoped to one subreddit, so discovery cannot ask "who across Reddit is posting about this". That phase is removed rather than faked; see [How discovery works](#how-discovery-works). |
| **Prefix-matched subreddit search** | The archive matches subreddit *names* by prefix instead of doing Reddit's fuzzy relevance search, so "tenant rights" finds r/TenantRights but not r/Renters. The curated catalog and the local term index cover that gap. |
| **No share links** | A mobile `/r/x/s/<token>` link is an opaque redirect only reddit.com can follow. Open it and paste the `/comments/…` URL it lands on. The app says so wherever you can paste one. |

---

## The four views

The shell is a nav rail on desktop, a tab bar on phones. Each view
renders lazily and is invalidated when the data behind it changes, so
switching views is instant and nothing recomputes that nobody is
looking at.

### Dashboard

Everything about the currently loaded set of subreddits. A KPI row sits
above six tabs — posts, upvotes, comments, average upvote ratio, the
best hour to post *named to the subreddit it belongs to*, and the
top-scoring post. On a phone those six tiles scroll sideways as one
snapping row rather than stacking.

| Tab | What is in it |
|---|---|
| **Summary** | What the data is telling you — see [below](#the-summary-is-a-briefing-not-a-recap) |
| **Timing** | **When posts go up** — a full-width timeline, switchable between *Per sub*, *Stacked*, *Density* (each sub normalised to its own peak, so cadence shapes overlay without volume bias) and *Total*, across windows from 1 day to all time, with bucket size following the window. Below it, **best hours to post per subreddit**: one small chart per community, each on its own clock — see [below](#posting-times-are-per-subreddit) |
| **Charts** | **Busiest days**, **score vs comments**, **side-by-side subreddit totals**, a **score histogram**, a **sentiment doughnut** and **recent-post velocity** |
| **Themes** | **Words coming up most**, and **topics that keep coming up** — recurring themes with sentiment, engagement, cross-sub spread and clickable examples |
| **Communities** | **What each subreddit looks like** — an audience fingerprint per sub: engagement style, reception, best hour, top themes |
| **Cross-posts** | **The same post in multiple subreddits**, detected across your loaded data and ranked by spread first and score second, so a post seeded into five subs outranks a single viral hit |

Only the selected tab is in the document flow, which is what keeps the
view to two or three screenfuls on a phone instead of eleven. It also
means a repaint builds one tab's charts rather than all ten; the
analysis behind them is computed once per scope and re-used as you move
between tabs.

### Campaigns

A campaign is a set of post IDs you are tracking together, usually the
same message cross-posted to several communities.

The list view shows every campaign as a tile with goal progress, plus a
14-day calendar strip and a two-campaign comparison. Opening one gives
you a KPI row and goal bars above six tabs:

| Section | What is in it |
|---|---|
| **Overview** | How the campaign is doing in plain English, what separates its best posts from its worst, and the fingerprint it presents to a new community |
| **Trends** | Campaign-scoped charts: activity over time by subreddit, score vs comments, title tone and score spread |
| **Subreddits** | When to post community by community, then a trend card per community the campaign reached, with its own cadence and posting-hour charts, plus a cross-sub comparison chart and table. When a sub has too few campaign posts to chart honestly, the card shows that sub's own posting rhythm instead and says how the campaign's timing compares. Discovery — see below — sits at the foot of the tab: the communities this campaign has reached, then the ones it has not. |
| **Posts** | Every tracked post, with paste-to-add, per-row removal, and **Where next** on each one |
| **Plan** | Cross-post cascade scheduling — see [How the cascade picks its times](#how-the-cascade-picks-its-times) — plus title prediction and rewriting, and volunteer coverage |
| **Settings** | Goals, digest export, delete |

Adding posts accepts full URLs, `redd.it` short URLs, `t3_…` fullnames
or bare IDs. A live chip preview shows what got recognised before you
commit. Mobile `/r/x/s/<token>` share links are the one thing that will
not work — the token is a redirect only reddit.com can follow — and the
preview says so instead of accepting a row that can never resolve.

### Communities

Where subreddits come from. Three tabs:

- **Search** — type-ahead over Reddit's subreddit search, the curated
  catalog and your local index, so results appear instantly offline and
  upgrade when the network answers. Each result can expand into its
  **similar communities**, derived from four independent signals with
  the contributing ones named.
- **Sphere catalog** — 20 progressive issue spheres, 51 state spheres
  (50 states plus DC), 6 audience spheres, 405 subreddits in total. Load
  a whole sphere, pick individual subs out of one, or take a starter
  bundle (*Progressive core*, *Movement & direct action*, *Economic
  justice*, *Civil rights*, *Climate*, *Democracy & courts*, *Safety net
  & disability*).

  Every issue and audience entry is checked against the archive rather
  than recalled: it has to exist, be public rather than private or
  restricted, have been posted in within the last 30 days, and have at
  least a thousand subscribers. The first audit of the hand-written
  catalog failed a third of it — nineteen names had no subreddit behind
  them, eighteen more were closed to posting, and r/Dreamers, filed
  under immigration, is a subreddit for an alt-rock band.
- **Loaded subs** — what is currently in the dashboard, with per-sub
  removal.

### Posts

A sortable, paginated table of every loaded post with per-view sub
filtering, title/author/flair search, and post-ID filtering. Tapping a
row opens a detail panel: top comments with sentiment, thread
temperature, upvote ratio, permalink, a title-quality score broken down
by factor (length, caps ratio, punctuation, numerals, brackets,
sentiment, clickbait), and **where else this post could go** — see
[below](#from-one-post-to-a-campaign).

---

## The summary is a briefing, not a recap

The Summary tab used to open with four paragraphs of prose. They restated
the totals already on screen in the KPI row directly above, ranked the
subreddits by total score, counted the sentiment split, and quoted the
top post — around 110 words, followed by a second card of takeaways that
repeated half of it. Nothing in there told you where or when to post.

It is now a labelled list you read by scanning the left column. Each row
is one finding, and the rules behind it are deliberately strict:

- **Nothing that is already a number on screen.** Totals, medians and
  percentiles live in the KPI row; the summary does not narrate them.
- **Communities are compared on the median post, never on totals.** A
  subreddit does not become the better place to post because more of its
  posts happen to be loaded. This changes the answer: given a community
  carrying 500k points off one viral post against a flat body, and
  another with 4k points spread evenly, the second is named — because
  that is the one where *your* next post is likely to do well.
- **A leader has to be clearly ahead**, by 25%, before it is named at
  all. Two communities separated by a rounding error produce no row
  rather than false confidence.
- **Rows are omitted when the data cannot support them.** One subreddit
  loaded means no where-to-post comparison. Too few posts in any single
  community means the timing row says so instead of guessing.
- **No line of reassurance.** A healthy upvote ratio gets the number and
  the word; it gets no sentence explaining that nothing is wrong.

The full breakdowns behind every row are a tab away.

---

## Posting times are per subreddit

Ask "when should I post" of a dashboard holding a dozen communities and
the honest answer is usually "that depends which one". r/politics peaks
at a different hour than a state organising sub, and pooling their
hour-of-day histograms produces a number that is true of neither.

So no timing figure in this app is pooled. `Analysis.postingTimes`
groups by subreddit before it measures anything, and every peak is
scored against that subreddit's own average — a `+40%` in a small sub is
a real finding even if its absolute scores never approach a big sub's
floor.

Two things keep the numbers honest:

- **Hour estimates are shrunk toward the sub's mean.** Twenty posts
  spread over twenty-four hours leaves most hours holding a single post,
  and the raw maximum of average-score-per-hour is then just "which lone
  post got lucky". Each hour is pulled toward the subreddit's own
  average by three imaginary average posts, so an hour has to be either
  busy or emphatically better than normal to win. Each panel says how
  many posts landed in the hour it is recommending.
- **Subs below the sample floor get no peak at all.** They are listed at
  the bottom of the card with their post count, rather than handed a
  peak hour they have not earned.

Where you see it:

| Surface | What it shows |
|---|---|
| **Dashboard → Best hours to post, per subreddit** | A chart per community: bars are average upvotes by hour, the line is how many posts landed in that hour. Under each one: the lift over that sub's own average, the sample behind the peak, its busiest weekday, where early traction is fastest, and its dead window. Six panels, with the rest a click away. |
| **Dashboard → KPI row** | The busiest subreddit's own peak, labelled with its name, plus how many other subs peak somewhere else. |
| **Dashboard → Summary** | The peak hour for each of the top three communities on one line, and how far the strongest of them beats its own average. |
| **Campaign → When to post, community by community** | The same per-sub reading scoped to the campaign. Where a campaign has too few posts in a community to measure, it borrows that subreddit's own loaded traffic — excluding the campaign's posts, so the answer is "when is this room busy" and not a restatement of when you posted — and says so on the row. |
| **Campaign → Subreddits** | A trend card per community with its own cadence and hour charts. |

---

## How the cascade picks its times

The Plan tab lays out a staggered posting order: one community per
slot, at least an hour apart, each as close as possible to its own best
time. Every stop carries a button that opens that community's submit
page with the post already written, so the plan is something you carry
out rather than something you re-enter into Reddit by hand.

Two posts cannot occupy the same slot, so somebody has to move, and
what the scheduler does about that is the whole design.

**Slots go to whoever has the most to gain.** Communities are sorted by
what a post at their peak is actually worth, and each takes its best
time if it is still free. Only then do the rest look for somewhere
else. The earlier version sorted by clock time instead and pushed
whatever collided, which let a community worth two points displace one
worth two thousand purely because it sorted first.

**A displaced stop slides along its own curve, not to the next free
hour.** A community with a broad afternoon plateau can move an hour and
lose nothing; one with a single sharp spike cannot. The scheduler
searches outward from the peak for the *best* remaining time rather
than the nearest, and each row reports how far it moved and what that
cost — `2h before peak · −9%`.

**The number on a row describes the time on that row.** It is read off
the fitted curve at the scheduled moment, so a stop pushed six hours
cannot advertise the score it would have got at its peak.

**The peak comes from [the timing model](#posting-times-are-per-subreddit)** —
the same fitted, shrunk, permutation-tested estimate the rest of the
app uses — not from the raw arg-max of average score by hour, where one
lucky post at 3am is enough to name 3am the best hour.

**The plan stops.** It covers the next two days and defaults to twelve
stops, and says how many communities it left out. A hundred stops an
hour apart is four days of the same content everywhere, which is what
spam looks like from the outside.

---

## From one post to a campaign

Discovery used to require a campaign. But the moment you are looking at
a post worth spreading, the same question already applies: what is this
about, and where else would it land?

**Open any post in the Posts table.** At the bottom of the detail panel,
*Where else this post could go* runs `Discovery.forPost` on the post's
own title, flair and body:

1. The post's text becomes a term vector and is ranked against every
   issue sphere in the catalog. The spheres that match appear as chips
   with their confidence — clicking one loads every community in it.
2. Those spheres bring their member communities, the post's home
   subreddit brings the siblings it is catalogued alongside, and
   anything with a similar cached description is added too.
3. Each community is scored on shared vocabulary, sphere fit, civic
   language, activity and reach, and every row says which words it
   matched on. Communities already in your dashboard are shown too,
   marked and greyed — "you are already in the right rooms" is an answer
   worth giving.

The offline result paints immediately and the live pass re-scores behind
it, so a slow or unreachable archive costs you nothing. Communities the
catalog knows but has never fetched still get a row, marked *description
not read yet*, rather than being dropped for something the index has not
got round to.

Then pick one of two buttons:

| Button | What happens |
|---|---|
| **Load the checked communities** | Adds them to your dashboard and pulls their posts. This is what gives each one a posting-time panel of its own, so you can see when to post there before you do. |
| **Make a campaign from this post** | Names a campaign after the post, suggests goals at 1.5× its current numbers, loads the checked communities alongside it, opens the campaign workspace and runs the full discovery pass — which also reaches Reddit's own search, wider than the catalog-only match above. |

The **+ Campaign** button on any table row is the same flow without
opening the post first; it shows the sphere match inline as a preview
before you commit. Both routes leave a checkbox you can clear if you
want the campaign without loading anything.

Rows are pre-checked only when they share actual vocabulary with the
post. A sphere sibling with no overlap is worth showing but not worth
loading on your behalf.

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

Two things about how that vocabulary is turned into a vector matter more
than they look. Each phrase is added on its own rather than as one
joined string, because the tokenizer also emits bigrams and joining the
list invented a bigram out of every adjacent pair of unrelated entries —
the labor sphere was carrying `steward strikefund` as one of its
heaviest features. And a multi-word phrase gives most of its weight to
the phrase rather than its halves, because `sanctuary city` identifies
immigration while `city` does not; at full weight a post about a city
cutting bus service ranked the immigration sphere above half the
catalog.

A run has four phases:

1. **Multi-angle search** — the campaign's vocabulary is split into
   several narrow queries rather than one broad one, and a sub matching
   more than one of them is a stronger signal than a sub matching the
   biggest.
2. **Sphere seeding** — every member of every sphere that scored.
3. **Description resolution** — `about.json` for every name in play,
   cached in IndexedDB for 30 days, so description matching is based on
   descriptions actually read and a second run is nearly free.
4. **Scoring** — theme, sphere fit, civic-space fit, engagement, reach
   and how many search angles found the sub, minus an off-topic penalty
   and a discount for mega-subs that match any vocabulary by sheer
   surface area.

There used to be a fifth phase between the first two: mining recent top
posts across Reddit for the campaign's keywords, which found active
communities that subreddit search never surfaces. The archive scopes
free-text search to one subreddit, so that question has no honest
answer any more and the phase is gone rather than left to return
nothing. Its weight in the composite moved to shared vocabulary and to
multi-angle corroboration, which is now the only evidence that a
community answers to the campaign from more than one direction.

Two of those signals are deliberately hedged, because each was a source
of confident-looking nonsense:

- **Sphere fit is weighted by the campaign's own confidence in the
  sphere.** How squarely a community sits in a sphere and whether your
  campaign belongs to that sphere are different questions. Scored
  together, one incidental word could rank a sphere and every curated
  member of it then scored as a perfect match — a post flaired *Police
  State* pulled in the racial justice sphere on the word "police", and
  the whole sphere came with it.
- **Curated catalog membership is credited for the sphere it was curated
  under, not in general.** A hand-listed community still has to belong
  to a sphere your campaign matches before it gets the full boost, or a
  pass through **Relevant** mode.

Theme is hedged too: a match resting on a single shared word keeps very
little of its score, because on documents this short one word in common
is a coincidence rather than a subject.

Each candidate carries reasoning that names the overlapping words rather
than restating its score, so you can tell a real match from a
coincidence — including when the honest answer is "this really is a
racial justice community, but your campaign is not a racial justice
campaign". The **Relevant / All** toggle re-filters the scored list in
place — no refetch, no waiting.

`Discovery.forPost` is the single-post variant of the same machinery,
minus the two phases that need Reddit's search. It runs from the post
detail panel and is described in
[From one post to a campaign](#from-one-post-to-a-campaign).

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

- Parallel multi-sub fetching at concurrency 3, with one retry and a
  hard per-request timeout so a stalled connection cannot hold up a
  batch.
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
| `js/dom.js` | Small DOM helpers: query, fill, delegate, empty states, skeletons, and the shared tab-rail and overflow-menu widgets |
| `js/theme.js` | Explicit dark/light/system switching, applied before first paint |
| `js/util.js` | Formatters, ID and share-URL parsing, concurrency-limited `pmap`, toasts, progress |
| `js/archive.js` | Arctic Shift adapter — presents an archive as Reddit's JSON API |
| `js/live.js` | Current scores from Reddit for posts too new for the archive |
| `js/reddit.js` | Request caching, listing pagination with streaming, batching, search |
| `js/postcache.js` | IndexedDB post cache |
| `js/subindex.js` | IndexedDB subreddit index: metadata, derived term vectors, stemming, 30-day TTL |
| `js/seeds.js` | The curated catalog — issue, state and audience spheres, starter bundles |
| `js/analysis.js` | Aggregates, activism-tuned lexicon sentiment, keywords and bigrams, themes, per-sub profiles and per-sub posting times, campaign profiles, comment-side analysis, title quality |
| `js/discovery.js` | The discovery pipeline: campaign and single-post vectors, sphere ranking, candidate scoring, filtering, similar communities |
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
.github/workflows/pages.yml
.nojekyll
```

---

## Notes on accuracy

- **Scores from the archive lag.** Recent posts carry provisional
  numbers and are marked as such; anything older than about 48 hours is
  accurate. Ranked listings only include settled scores. Posts under 36
  hours old are read from Reddit directly instead, and marked live.
- **The archive is the source for everything settled**, so anything
  Reddit's own API could answer but an archive cannot — site-wide
  search, share-link expansion, true *Hot* ranking — is absent rather
  than approximated silently. Each is listed above with what replaced
  it. Live lookups cover current scores only; they are not a second
  search index.
- **Sentiment** is a lexicon scorer tuned for civic vocabulary
  (`organize`, `solidarity`, `oppress`, `betray`). Directional, not
  authoritative.
- **Themes** are keyword and bigram frequency with a stopword filter —
  no language model, no remote AI. A phrase theme that wholly contains a
  single-word theme suppresses the single word.
- **Discovery scores** are cosine similarity over term vectors plus
  named heuristics. Every candidate lists the words and signals behind
  its number, because a fit score you cannot check is not worth much.
- **Posting times are never pooled across subreddits**, and a peak is
  shrunk toward the subreddit's own mean so a single lucky post cannot
  crown its hour. Each panel reports the sample it is working from;
  subreddits below the floor get no peak at all.
- **Awards** are gone: Reddit retired them in 2023 and the fields are
  always zero, so the dashboard drops them rather than charting zeros.
- **`view_count`** is hidden by Reddit from non-owners on most posts.
  The dashboard shows it when present and says so when absent rather
  than inventing a number.

---

## License

[MIT](LICENSE) — do as you like, no warranty.
