# old-reddit-json-reporter

A zero-backend, GitHub Pages-ready dashboard that scrubs old Reddit's `/json`
endpoints to produce **trend analysis, AI-style insights, and cross-post
campaign tracking** — in the spirit of redditstats.com but focused on
gauging how a list of cross-posts is performing across multiple subreddits.

> Default subreddits: **r/Political_Revolution** and **r/50501**. Add or
> remove any other community at runtime — the chips persist in your browser.

## What it does

- Fetches the public JSON feed for any subreddit listing (`hot`, `new`,
  `top`, `rising`) directly from `https://www.reddit.com/r/<sub>/<listing>.json`.
  No proxy, no API key.
- Aggregates totals across the loaded posts: upvotes, comments, awards,
  upvote ratio, view counts (where Reddit reports them), best/worst post.
- Renders interactive charts with Chart.js:
  - submissions over time
  - score-vs-comments engagement scatter
  - subreddit comparison bars
  - score distribution histogram
  - average score by hour of day (local time)
  - day-of-week activity
  - score & comment velocity for the most recent posts
  - title-sentiment doughnut
- AI-style insights derived from the loaded data:
  - lexicon sentiment scoring (activism-tuned vocabulary)
  - top keyword cloud (stopword-filtered TF)
  - cross-post detection (same title or URL across multiple subs)
  - heuristic recommendations (best hour/day, reception, ratio insights)
  - auto-generated narrative summary
- Per-post drill-down: top comments, comment count summary, comment
  sentiment, upvote ratio, awards, hidden view-count flag, permalink.
- **Campaign manager**: name a campaign, paste a list of post IDs, set a
  goal-upvotes / goal-comments target. The dashboard fetches every post by
  ID and shows total upvotes, comments, awards, views, distinct subreddits
  hit, and progress toward each goal. Campaigns persist in `localStorage`.
- Filter by **post ID** (single or comma-separated), search by title /
  author / flair, sort the table by any column.
- Status bar with cache-controlled fetches + retries with exponential
  backoff + sessionStorage caching to be polite to Reddit.

## Run locally

It's static HTML. Any HTTP server will do:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

The browser fetches Reddit JSON directly. Reddit serves these endpoints
with permissive CORS for unauthenticated GETs, but enforces rate limits;
the app retries with backoff and caches responses for 5 minutes per page
load.

## Deploy to GitHub Pages

`.github/workflows/pages.yml` is set up to deploy the repository root to
GitHub Pages on every push to `main`. After the first push:

1. Go to the repo's **Settings → Pages**.
2. Set **Source** to **GitHub Actions**.
3. The workflow will publish the site at
   `https://<user>.github.io/<repo>/`.

`.nojekyll` is included so the `js/` and `css/` directories are served
verbatim.

## How it gauges campaign performance

Each campaign stores a list of post IDs you've cross-posted (e.g. the
same call-to-action submitted to r/Political_Revolution, r/50501, and
two other communities). When you open the campaign:

1. The dashboard calls `/by_id/t3_<id>,t3_<id>,…json` (up to 100 IDs per
   call, batched automatically).
2. Each resolved post contributes its current upvotes, comments, awards,
   and (if Reddit reports it) view count to the totals.
3. Progress bars show how close the aggregate is to your goal upvotes
   and goal comments.
4. The list of distinct subreddits the campaign reached is summarised so
   you can see how broadly the message has propagated.

> Reddit hides `view_count` from non-owner accounts on most posts, so
> view totals will usually be lower than the true reach. The dashboard
> labels this honestly rather than fabricating numbers.

## Filtering by post ID

The **Filter by post ID** input on the controls bar narrows the loaded
listing down to the post IDs you supply (comma- or whitespace-separated).
This is useful for examining a specific cross-post run within the broader
listing context.

## File layout

```
index.html              # shell, controls, KPI/tabs
css/styles.css          # dark + light theme, responsive
js/util.js              # formatting, time helpers, debounce, toast
js/reddit.js            # JSON fetcher + caching + retry + by_id batching
js/analysis.js          # aggregates, sentiment, keywords, cross-posts
js/charts.js            # Chart.js wrappers
js/campaigns.js         # localStorage-backed campaigns
js/ui.js                # DOM rendering helpers
js/app.js               # orchestrator, state, event wiring
.github/workflows/pages.yml
.nojekyll
```

## Notes on accuracy

- Sentiment is a **lexicon** scorer tuned for activism keywords. Treat
  the score as directional, not authoritative.
- Keywords use a basic stopword filter and raw frequency — no language
  model, no TF-IDF corpus.
- The "AI Insights" tab labels everything that could be misread as a
  black-box prediction. The numbers come from the dataset on screen.
- Reddit's API may rate-limit aggressive refreshes. The app caches each
  endpoint for 5 minutes per page load and retries with exponential
  backoff on `429`s.
