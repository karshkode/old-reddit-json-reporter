/* Analysis helpers: aggregations, sentiment, keywords, time bucketing,
 * cross-post detection, and narrative summary generation.
 *
 * Everything is heuristic and runs entirely client-side. We label the
 * pattern-recognition output as "AI insights" because that is the user-facing
 * framing, but no model is shipped — these are deterministic statistics.
 */
(function () {
  const Analysis = {};

  /* ---------- Aggregates ---------- */

  Analysis.aggregate = function (posts) {
    if (!posts || !posts.length) {
      return {
        count: 0, totalScore: 0, totalComments: 0, totalAwards: 0,
        totalViews: 0, viewsKnown: 0,
        avgScore: 0, medianScore: 0, p95Score: 0,
        avgComments: 0, avgUpvoteRatio: 0,
        topPost: null, lowPost: null,
        bySubreddit: {}, byHour: new Array(24).fill(0), byDow: new Array(7).fill(0),
        avgScoreByHour: new Array(24).fill(0),
        flairs: {}, authors: {},
      };
    }
    const scores = posts.map((p) => p.score || 0);
    const comments = posts.map((p) => p.num_comments || 0);
    const ratios = posts.map((p) => p.upvote_ratio || 0).filter((x) => x > 0);
    const totalViews = posts.reduce((a, b) => a + (b.view_count || 0), 0);
    const viewsKnown = posts.filter((p) => p.view_count != null).length;

    const bySubreddit = {};
    const byHour = new Array(24).fill(0);
    const byDow = new Array(7).fill(0);
    const sumScoreByHour = new Array(24).fill(0);
    const cntByHour = new Array(24).fill(0);
    const flairs = {};
    const authors = {};

    let topPost = posts[0];
    let lowPost = posts[0];
    for (const p of posts) {
      const s = p.score || 0;
      if (s > (topPost.score || 0)) topPost = p;
      if (s < (lowPost.score || 0)) lowPost = p;
      const sub = (p.subreddit || "").toLowerCase();
      if (!bySubreddit[sub]) bySubreddit[sub] = { count: 0, score: 0, comments: 0, awards: 0, views: 0 };
      bySubreddit[sub].count++;
      bySubreddit[sub].score += s;
      bySubreddit[sub].comments += p.num_comments || 0;
      bySubreddit[sub].awards += p.total_awards || 0;
      bySubreddit[sub].views += p.view_count || 0;
      if (p.created_utc) {
        const d = new Date(p.created_utc * 1000);
        const h = d.getUTCHours();
        const w = d.getUTCDay();
        byHour[h]++;
        byDow[w]++;
        sumScoreByHour[h] += s;
        cntByHour[h]++;
      }
      if (p.flair) flairs[p.flair] = (flairs[p.flair] || 0) + 1;
      if (p.author) authors[p.author] = (authors[p.author] || 0) + 1;
    }

    const avgScoreByHour = sumScoreByHour.map((sum, i) => (cntByHour[i] ? sum / cntByHour[i] : 0));

    return {
      count: posts.length,
      totalScore: scores.reduce((a, b) => a + b, 0),
      totalComments: comments.reduce((a, b) => a + b, 0),
      totalAwards: posts.reduce((a, b) => a + (b.total_awards || 0), 0),
      totalViews,
      viewsKnown,
      avgScore: Util.average(scores),
      medianScore: Util.median(scores),
      p95Score: Util.percentile(scores, 95),
      avgComments: Util.average(comments),
      avgUpvoteRatio: ratios.length ? Util.average(ratios) : null,
      topPost,
      lowPost,
      bySubreddit,
      byHour,
      byDow,
      avgScoreByHour,
      flairs,
      authors,
    };
  };

  /* ---------- Sentiment (lexicon) ---------- */

  const POS = new Set([
    "good", "great", "love", "amazing", "win", "wins", "winning", "support",
    "victory", "best", "happy", "hope", "hopeful", "powerful", "strong",
    "thank", "thanks", "thankful", "celebrate", "proud", "rise", "united",
    "freedom", "save", "saved", "saving", "help", "helping", "free", "fight",
    "fights", "solidarity", "progress", "progressive", "vote", "voting",
    "voted", "rally", "march", "people", "yes", "approve", "approved",
    "succeed", "success", "successful",
  ]);
  const NEG = new Set([
    "bad", "hate", "terrible", "lose", "loss", "loser", "fail", "failed",
    "failure", "scam", "fraud", "corrupt", "corruption", "racist", "fascist",
    "fascism", "nazi", "tyranny", "tyrant", "ban", "banned", "shut",
    "shutdown", "stolen", "steal", "lies", "lie", "lying", "liar",
    "outrage", "angry", "rage", "evil", "destroy", "destroyed", "no",
    "nope", "veto", "block", "blocked", "denied", "deny", "abuse",
    "abusive", "violence", "violent", "attack", "attacked",
  ]);

  Analysis.scoreSentiment = function (text) {
    if (!text) return { score: 0, pos: 0, neg: 0 };
    const tokens = String(text).toLowerCase().match(/[a-z']+/g) || [];
    let pos = 0, neg = 0;
    for (const t of tokens) {
      if (POS.has(t)) pos++;
      else if (NEG.has(t)) neg++;
    }
    const total = pos + neg;
    return { score: total ? (pos - neg) / total : 0, pos, neg };
  };

  Analysis.aggregateSentiment = function (posts) {
    let pos = 0, neg = 0, neu = 0, sum = 0;
    for (const p of posts) {
      const s = Analysis.scoreSentiment((p.title || "") + " " + (p.selftext || "").slice(0, 240));
      sum += s.score;
      if (s.pos > s.neg) pos++;
      else if (s.neg > s.pos) neg++;
      else neu++;
    }
    return { positive: pos, negative: neg, neutral: neu, average: posts.length ? sum / posts.length : 0 };
  };

  /* ---------- Keyword extraction ---------- */

  const STOPWORDS = new Set([
    "the","a","an","and","or","but","of","to","in","on","for","with","is","are",
    "was","were","be","been","being","this","that","these","those","it","its",
    "as","at","by","from","into","up","down","out","off","over","under","than",
    "then","so","not","no","yes","do","does","did","done","have","has","had",
    "i","you","he","she","they","we","me","my","your","his","her","their","our",
    "us","them","what","who","whom","which","why","how","when","where","there",
    "here","just","more","less","also","too","very","can","could","should","would",
    "will","won","wont","shall","may","might","must","about","like","one","two",
    "if","else","while","because","amp","im","ive","dont","didnt","cant","wont",
    "thats","its","theyre","youre","got","get","gets","new","says","said","say",
    "now","still","via","etc","per","upon","via","r","u","www","http","https",
  ]);

  Analysis.extractKeywords = function (posts, limit) {
    const counts = {};
    for (const p of posts) {
      const toks = ((p.title || "") + " " + (p.flair || "")).toLowerCase().match(/[a-z][a-z'\-]{2,}/g) || [];
      for (const t of toks) {
        if (STOPWORDS.has(t)) continue;
        if (t.length < 3) continue;
        counts[t] = (counts[t] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit || 30);
  };

  /* ---------- Cross-post detection ---------- */

  Analysis.detectCrossPosts = function (posts) {
    const byTitle = new Map();
    const byUrl = new Map();
    for (const p of posts) {
      const tk = (p.title || "").toLowerCase().replace(/\s+/g, " ").trim();
      if (tk) {
        if (!byTitle.has(tk)) byTitle.set(tk, []);
        byTitle.get(tk).push(p);
      }
      if (p.url && !p.is_self) {
        const u = p.url.split("?")[0];
        if (!byUrl.has(u)) byUrl.set(u, []);
        byUrl.get(u).push(p);
      }
    }
    const groups = [];
    function consider(map, kind) {
      for (const [key, list] of map.entries()) {
        const subs = new Set(list.map((p) => (p.subreddit || "").toLowerCase()));
        if (subs.size >= 2) {
          groups.push({
            kind,
            key,
            subs: Array.from(subs),
            posts: list,
            totalScore: list.reduce((a, b) => a + (b.score || 0), 0),
            totalComments: list.reduce((a, b) => a + (b.num_comments || 0), 0),
          });
        }
      }
    }
    consider(byTitle, "title");
    consider(byUrl, "url");
    const seen = new Set();
    return groups
      .sort((a, b) => b.totalScore - a.totalScore)
      .filter((g) => {
        const sig = g.posts.map((p) => p.id).sort().join(",");
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
      });
  };

  /* ---------- Recommendations / narrative ---------- */

  const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

  Analysis.recommendations = function (agg, sentiment, posts) {
    const out = [];
    if (!agg || !agg.count) {
      out.push("No posts loaded yet — pick a subreddit and refresh to begin analysis.");
      return out;
    }

    let bestHour = 0, bestVal = -Infinity;
    for (let h = 0; h < 24; h++) {
      if (agg.avgScoreByHour[h] > bestVal && agg.byHour[h] > 0) {
        bestVal = agg.avgScoreByHour[h];
        bestHour = h;
      }
    }
    out.push(`Posts published around <strong>${String(bestHour).padStart(2, "0")}:00 UTC</strong> show the highest average score in this dataset (${Util.fmtNum(bestVal)} avg).`);

    let bestDow = 0, bestDowVal = -1;
    for (let d = 0; d < 7; d++) {
      if (agg.byDow[d] > bestDowVal) { bestDowVal = agg.byDow[d]; bestDow = d; }
    }
    out.push(`<strong>${DAY_NAMES[bestDow]}</strong> is the most active submission day across the loaded window (${bestDowVal} posts).`);

    if (agg.avgUpvoteRatio != null) {
      const r = agg.avgUpvoteRatio;
      if (r >= 0.9) out.push(`Audience reception is <strong>strongly positive</strong> — average upvote ratio ${Util.fmtPct(r)}.`);
      else if (r >= 0.75) out.push(`Audience reception is <strong>healthy</strong> — average upvote ratio ${Util.fmtPct(r)}.`);
      else if (r >= 0.6) out.push(`Audience reception is <strong>mixed</strong> — average upvote ratio ${Util.fmtPct(r)}; consider tightening title framing.`);
      else out.push(`Audience reception looks <strong>contentious</strong> — average upvote ratio ${Util.fmtPct(r)}. Posts may be drawing brigading or off-topic engagement.`);
    }

    if (sentiment) {
      if (sentiment.average > 0.15) out.push(`Title sentiment skews <strong>positive</strong> (${sentiment.positive} pos / ${sentiment.negative} neg).`);
      else if (sentiment.average < -0.15) out.push(`Title sentiment skews <strong>negative</strong> (${sentiment.positive} pos / ${sentiment.negative} neg) — common for activism/news framing.`);
      else out.push(`Title sentiment is <strong>roughly balanced</strong> (${sentiment.positive} pos / ${sentiment.negative} neg).`);
    }

    if (agg.topPost) {
      out.push(`Top performer: <strong>${Util.escapeHtml((agg.topPost.title || "").slice(0, 110))}</strong> in r/${Util.escapeHtml(agg.topPost.subreddit)} — ${Util.fmtNum(agg.topPost.score)} score, ${Util.fmtNum(agg.topPost.num_comments)} comments.`);
    }

    const ratio = agg.avgComments > 0 ? agg.avgScore / Math.max(1, agg.avgComments) : 0;
    if (ratio >= 25) out.push(`Posts attract upvotes faster than comments (≈${ratio.toFixed(1)}× score-to-comment ratio) — content is more shareable than discussion-provoking.`);
    else if (ratio > 0 && ratio <= 5) out.push(`Posts spark above-average discussion (low score-to-comment ratio of ${ratio.toFixed(1)}) — strong community-engagement content.`);

    if (agg.viewsKnown && agg.viewsKnown < agg.count) {
      out.push(`View counts are only known for ${agg.viewsKnown} of ${agg.count} posts — Reddit hides <code>view_count</code> from non-owners on most submissions.`);
    }

    return out;
  };

  Analysis.narrative = function (agg, sentiment, subs) {
    if (!agg || !agg.count) return "<p>No data loaded yet. Add a subreddit and refresh.</p>";
    const subsList = subs.map((s) => `r/${Util.escapeHtml(s)}`).join(", ");
    const parts = [];
    parts.push(`<p>Across ${subsList || "the loaded subreddits"}, <strong>${agg.count}</strong> posts collected <strong>${Util.fmtNum(agg.totalScore)}</strong> upvotes and <strong>${Util.fmtNum(agg.totalComments)}</strong> comments. Median score is <strong>${Util.fmtNum(agg.medianScore)}</strong>; the 95th percentile clears <strong>${Util.fmtNum(agg.p95Score)}</strong>.</p>`);
    const subList = Object.entries(agg.bySubreddit)
      .sort((a, b) => b[1].score - a[1].score)
      .map(([k, v]) => `r/${k} (${Util.fmtNum(v.score)} pts, ${Util.fmtNum(v.comments)} comments across ${v.count} posts)`);
    if (subList.length > 1) {
      parts.push(`<p>Subreddit ranking by total score: ${subList.join(" · ")}.</p>`);
    }
    if (sentiment) {
      const lean = sentiment.average > 0.1 ? "positive-leaning" : sentiment.average < -0.1 ? "negative-leaning" : "balanced";
      parts.push(`<p>Title sentiment is <strong>${lean}</strong>: ${sentiment.positive} positive / ${sentiment.negative} negative / ${sentiment.neutral} neutral. The lexicon is tuned for activism keywords so treat values as directional.</p>`);
    }
    if (agg.topPost) {
      parts.push(`<p>The single highest-performing post is <a href="${Util.escapeHtml(agg.topPost.permalink)}" target="_blank" rel="noopener">${Util.escapeHtml((agg.topPost.title || "").slice(0, 140))}</a> with ${Util.fmtNum(agg.topPost.score)} upvotes and ${Util.fmtNum(agg.topPost.num_comments)} comments in r/${Util.escapeHtml(agg.topPost.subreddit)}.</p>`);
    }
    return parts.join("\n");
  };

  /* ---------- Time bucketing ---------- */

  Analysis.bucketByHour = function (posts) {
    const map = new Map();
    for (const p of posts) {
      if (!p.created_utc) continue;
      const d = new Date(p.created_utc * 1000);
      d.setUTCMinutes(0, 0, 0);
      const k = d.toISOString();
      map.set(k, (map.get(k) || 0) + 1);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([t, n]) => ({ t, n }));
  };

  Analysis.scoreHistogram = function (posts, bins) {
    bins = bins || 12;
    if (!posts.length) return { labels: [], counts: [] };
    const scores = posts.map((p) => p.score || 0);
    const max = Math.max(...scores);
    const min = Math.min(...scores);
    const span = Math.max(1, max - min);
    const step = span / bins;
    const labels = [];
    const counts = new Array(bins).fill(0);
    for (let i = 0; i < bins; i++) {
      const lo = min + i * step;
      const hi = lo + step;
      labels.push(`${Util.fmtNum(lo)}–${Util.fmtNum(hi)}`);
    }
    for (const s of scores) {
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((s - min) / step)));
      counts[idx]++;
    }
    return { labels, counts };
  };

  window.Analysis = Analysis;
})();
