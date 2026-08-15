/* Analysis helpers — aggregations, sentiment, themes, audience profiles,
 * targeting recommendations, title quality, narrative generation.
 *
 * Everything is heuristic and runs entirely client-side. We label the
 * pattern-recognition output as "AI insights" because that is the user-facing
 * framing, but no model is shipped — these are deterministic statistics and
 * lexicon-based scoring tuned for activism / civic / political content.
 */
(function () {
  const Analysis = {};

  /* ============================================================
     1. SENTIMENT LEXICON  (activism / civic-discourse tuned)
     ============================================================ */

  const POS = new Set([
    "good", "great", "love", "amazing", "win", "wins", "winning", "won",
    "victory", "victorious", "best", "happy", "hope", "hopeful", "powerful",
    "strong", "strength", "thank", "thanks", "thankful", "grateful",
    "appreciate", "celebrate", "celebrated", "proud", "rise", "rising",
    "united", "unite", "unity", "freedom", "liberty", "save", "saved",
    "saving", "help", "helping", "helpful", "free", "succeed", "success",
    "successful", "achieve", "achievement", "milestone", "breakthrough",
    "fight", "fights", "fighting", "solidarity", "progress", "progressive",
    "vote", "voting", "voted", "rally", "march", "marched", "people",
    "approve", "approved", "support", "supported", "supporter",
    "organize", "organized", "organizing", "build", "building", "built",
    "inspire", "inspired", "inspiring", "protect", "protected", "protector",
    "defend", "defended", "defender", "together", "justice", "just",
    "fair", "fairness", "equal", "equality", "peace", "peaceful",
    "reform", "reformed", "improve", "improved", "improvement", "improving",
    "honest", "honesty", "truth", "true", "transparent",
    "courage", "courageous", "brave", "bravery", "resilient", "resilience",
    "energize", "energized", "passionate", "thriving", "empower",
    "empowered", "empowering", "stand", "standing",
  ]);

  const NEG = new Set([
    "bad", "hate", "hated", "hateful", "terrible", "awful", "horrible",
    "lose", "loss", "loser", "losing", "lost", "fail", "failed",
    "failing", "failure", "scam", "fraud", "rigged", "corrupt", "corruption",
    "racist", "racism", "fascist", "fascism", "authoritarian", "tyranny",
    "tyrant", "dictator", "dictatorship", "nazi", "ban", "banned",
    "shutdown", "stolen", "steal", "stealing", "lies", "lie", "lying",
    "liar", "outrage", "angry", "rage", "evil", "destroy", "destroyed",
    "destroying", "destruction", "veto", "vetoed", "block", "blocked",
    "denied", "deny", "abuse", "abusive", "violence", "violent",
    "attack", "attacked", "assault", "assaulted", "crisis", "emergency",
    "threat", "threatened", "threatening", "danger", "dangerous",
    "oppress", "oppressed", "oppression", "suppress", "suppressed",
    "betray", "betrayed", "betrayal", "killed", "death", "deaths",
    "dead", "die", "dies", "dying", "murder", "murdered",
    "war", "warfare", "atrocity", "genocide", "ethnic-cleansing",
    "worse", "worst", "shame", "shameful", "disgrace", "disgraceful",
    "scandal", "outrageous", "ridiculous", "disaster", "disastrous",
    "deceit", "deceived", "deceitful", "manipulate", "manipulated",
    "hostile", "hostility", "panic", "fear", "feared",
    "stripped", "strip", "denying", "purge", "purged",
  ]);

  Analysis.scoreSentiment = function (text) {
    if (!text) return { score: 0, pos: 0, neg: 0 };
    const tokens = String(text).toLowerCase().match(/[a-z'-]+/g) || [];
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
    return {
      positive: pos, negative: neg, neutral: neu,
      average: posts.length ? sum / posts.length : 0,
    };
  };

  /* ============================================================
     2. STOPWORDS + KEYWORD / BIGRAM EXTRACTION
     ============================================================ */

  const STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for",
    "with", "is", "are", "was", "were", "be", "been", "being", "this",
    "that", "these", "those", "it", "its", "as", "at", "by", "from",
    "into", "up", "down", "out", "off", "over", "under", "than", "then",
    "so", "not", "no", "yes", "do", "does", "did", "done", "have", "has",
    "had", "i", "you", "he", "she", "they", "we", "me", "my", "your",
    "his", "her", "their", "our", "us", "them", "what", "who", "whom",
    "which", "why", "how", "when", "where", "there", "here", "just",
    "more", "less", "also", "too", "very", "can", "could", "should",
    "would", "will", "won", "wont", "shall", "may", "might", "must",
    "about", "like", "one", "two", "if", "else", "while", "because",
    "amp", "im", "ive", "dont", "didnt", "cant", "wont", "thats",
    "theyre", "youre", "got", "get", "gets", "new", "says", "said", "say",
    "now", "still", "via", "etc", "per", "upon", "r", "u", "www", "http",
    "https", "com", "org", "be", "going", "go", "see", "seen", "make",
    "made", "take", "taking", "took", "use", "used", "using", "want",
    "need", "let", "lets", "looks", "look", "looking", "really", "even",
    "ever", "always", "never", "many", "much", "any", "some", "all",
    "every", "another", "such", "own", "same", "other", "though", "back",
    "first", "second", "next", "last", "last-night", "today", "yesterday",
    "tomorrow", "people", "thing", "things", "way", "ways",
  ]);

  /* SubIndex keeps the larger, more carefully pruned stoplist because it
   * has to survive subreddit sidebar boilerplate. Post titles benefit
   * from the same exclusions — without them, calendar words like "after"
   * and "months" surface as "overlapping keywords" in target reasoning,
   * which reads as noise. */
  if (window.SubIndex && SubIndex.STOP) for (const w of SubIndex.STOP) STOPWORDS.add(w);

  /* Words that are grammar rather than subject: see the note on
   * SubIndex.WEAK. They are not dropped, because "far right" and "young
   * voters" need them, but they never stand as a keyword or a theme of
   * their own. Kept apart from STOPWORDS deliberately — folding them in
   * would take the phrases with them. */
  function isWeak(term) {
    if (!window.SubIndex || !SubIndex.WEAK) return false;
    return SubIndex.WEAK.has(term) || SubIndex.WEAK.has(SubIndex.stem(term));
  }

  const CLAUSE = /[.,;:!?()\[\]{}"|/\\\u2013\u2014\u2022\n\r]+/;

  function tokenize(text) {
    const runs = tokenizeRuns(text);
    return runs.length === 1 ? runs[0] : [].concat.apply([], runs);
  }

  /* Stretches of words that really were next to each other, so phrases
   * are only built from adjacency that exists. Without this, dropping
   * the stopwords out of "wage theft and the fight for better pay"
   * leaves every survivor touching every other one and the phrase list
   * fills up with pairs nobody wrote. */
  function tokenizeRuns(text) {
    const runs = [];
    for (const clause of String(text || "").toLowerCase().split(CLAUSE)) {
      let run = [];
      for (const word of clause.split(/[^a-z'-]+/)) {
        /* "here's" is not a word the way "here" is, and no stoplist
         * will ever hold every contraction. */
        const bare = word.replace(/^['-]+|['-]+$/g, "").replace(/'(s|re|ve|ll|d|m|t)$/, "");
        const t = /^[a-z][a-z'-]{2,}$/.test(bare) ? bare : "";
        if (t && !STOPWORDS.has(t) && t.length <= 28) {
          run.push(t);
        } else if (run.length) {
          runs.push(run);
          run = [];
        }
      }
      if (run.length) runs.push(run);
    }
    return runs;
  }

  /* The words of a post, headline and body alike. Counted once per post
   * rather than once per mention, so a term repeated twenty times in
   * one long body ranks as one post talking about it — which is what a
   * theme is. Without that, keyword lists from text-post communities
   * are just whichever author wrote the most. */
  function postTerms(p) {
    return new Set(tokenize(Util.postText(p, BODY_SCAN)));
  }

  /* Bodies are read up to this many characters when mining keywords.
   * Long enough for the argument, short enough that a copy-pasted
   * article does not become the campaign's vocabulary. */
  const BODY_SCAN = 2000;

  Analysis.extractKeywords = function (posts, limit) {
    const counts = {};
    for (const p of posts) {
      for (const t of postTerms(p)) counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts)
      .filter(([word]) => !isWeak(word))
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit || 30);
  };

  Analysis.extractBigrams = function (posts, limit) {
    const counts = {};
    for (const p of posts) {
      const seen = new Set();
      for (const toks of tokenizeRuns(Util.postText(p, BODY_SCAN))) {
        for (let i = 0; i < toks.length - 1; i++) {
          const k = toks[i] + " " + toks[i + 1];
          /* Only a phrase of two grammar words is worthless. One of
             each is the useful case: "far right", "young voters". */
          if (isWeak(toks[i]) && isWeak(toks[i + 1])) continue;
          if (seen.has(k)) continue;
          seen.add(k);
          counts[k] = (counts[k] || 0) + 1;
        }
      }
    }
    return Object.entries(counts)
      .filter(([, c]) => c >= 2)
      .map(([phrase, count]) => ({ phrase, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit || 15);
  };

  /* ============================================================
     3. THEME CLUSTERING
     ------------------------------------------------------------
     A "theme" is a frequent term (uni- or bigram). We tag every post
     that contains the term with that theme, then compute engagement
     and sentiment per theme. Posts can belong to multiple themes.
     ============================================================ */

  Analysis.themes = function (posts, opts) {
    opts = opts || {};
    const wantUni = opts.uniTop || 14;
    const wantBi = opts.biTop || 8;
    const minPosts = opts.minPosts || 2;

    if (!posts || !posts.length) return [];

    const uni = Analysis.extractKeywords(posts, 60).slice(0, wantUni);
    const bi = Analysis.extractBigrams(posts, 30).slice(0, wantBi);
    const seeds = [
      ...bi.map((x) => ({ kind: "phrase", term: x.phrase })),
      ...uni.map((x) => ({ kind: "word", term: x.word })),
    ];

    /* Stripping markdown out of a body is not free, and every seed
     * rescans every post. Twenty seeds against twenty thousand posts is
     * four hundred thousand rescans of text that has not changed. */
    const text = posts.map((p) => Util.postText(p, BODY_SCAN));

    const out = [];
    for (const seed of seeds) {
      const re = seed.kind === "phrase"
        ? new RegExp("\\b" + escapeRe(seed.term) + "\\b", "i")
        : new RegExp("\\b" + escapeRe(seed.term) + "\\b", "i");
      const matches = posts.filter((p, i) => re.test(text[i]));
      if (matches.length < minPosts) continue;

      const sent = Analysis.aggregateSentiment(matches);
      const totalScore = matches.reduce((a, b) => a + (b.score || 0), 0);
      const totalComments = matches.reduce((a, b) => a + (b.num_comments || 0), 0);
      const subs = {};
      for (const m of matches) {
        const s = (m.subreddit || "").toLowerCase();
        subs[s] = (subs[s] || 0) + 1;
      }
      const topSub = Object.entries(subs).sort((a, b) => b[1] - a[1])[0];
      const examples = matches
        .slice()
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 3);

      out.push({
        kind: seed.kind,
        term: seed.term,
        count: matches.length,
        totalScore,
        totalComments,
        avgScore: totalScore / matches.length,
        avgComments: totalComments / matches.length,
        sentiment: sent,
        topSub: topSub ? topSub[0] : null,
        subSpread: Object.keys(subs).length,
        examples,
      });
    }
    out.sort((a, b) => b.totalScore - a.totalScore);
    return dedupeThemes(out);
  };

  function dedupeThemes(themes) {
    /* If a unigram theme is fully contained within a bigram theme that
     * has roughly the same coverage, drop the unigram. e.g. "general"
     * shouldn't appear separately from "general strike" if every post
     * tagged "general" is also tagged "general strike". */
    const out = [];
    for (const t of themes) {
      let dup = false;
      for (const k of out) {
        if (k.kind === "phrase" && k.term.split(" ").includes(t.term) &&
            t.kind === "word" && Math.abs(t.count - k.count) <= 1) {
          dup = true;
          break;
        }
      }
      if (!dup) out.push(t);
    }
    return out;
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /* ============================================================
     4. AGGREGATE  (existing API kept stable)
     ============================================================ */

  Analysis.aggregate = function (posts) {
    if (!posts || !posts.length) {
      return {
        count: 0, totalScore: 0, totalComments: 0, totalAwards: 0,
        totalViews: 0, viewsKnown: 0,
        avgScore: 0, medianScore: 0, p95Score: 0,
        avgComments: 0, avgUpvoteRatio: null,
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
    /* Velocity (score / hours-of-age) bucketed by submission hour.
     * Used to compute a less-biased "best hour" — the raw
     * `avgScoreByHour` favors hours where posts have had the most
     * time to accrue score, which biases toward earlier-submitted
     * posts in any /hot snapshot. Velocity normalizes by post age
     * so a 24h-old post with 1000 score (~42/h) and a 6h-old post
     * with 250 score (~42/h) are treated as equally successful. */
    const sumVelocityByHour = new Array(24).fill(0);
    const cntVelocityByHour = new Array(24).fill(0);
    const nowSec = Date.now() / 1000;
    const flairs = {};
    const authors = {};

    let topPost = posts[0], lowPost = posts[0];
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
        const h = d.getHours(); /* local-time hour bucket */
        byHour[h]++;
        byDow[d.getDay()]++;
        sumScoreByHour[h] += s;
        cntByHour[h]++;
        /* Velocity: score per hour of post age. Floor age at 30
         * minutes so brand-new posts don't have absurdly inflated
         * rates from the small denominator (a 5-minute-old post
         * with 60 score would otherwise read as 720/h, dwarfing
         * mature posts). */
        const ageHours = Math.max(0.5, (nowSec - p.created_utc) / 3600);
        sumVelocityByHour[h] += s / ageHours;
        cntVelocityByHour[h]++;
      }
      if (p.flair) flairs[p.flair] = (flairs[p.flair] || 0) + 1;
      if (p.author) authors[p.author] = (authors[p.author] || 0) + 1;
    }

    const avgScoreByHour = sumScoreByHour.map((sum, i) => (cntByHour[i] ? sum / cntByHour[i] : 0));
    const avgVelocityByHour = sumVelocityByHour.map((sum, i) => (cntVelocityByHour[i] ? sum / cntVelocityByHour[i] : 0));

    return {
      count: posts.length,
      totalScore: scores.reduce((a, b) => a + b, 0),
      totalComments: comments.reduce((a, b) => a + b, 0),
      totalAwards: posts.reduce((a, b) => a + (b.total_awards || 0), 0),
      totalViews, viewsKnown,
      avgScore: Util.average(scores),
      medianScore: Util.median(scores),
      p95Score: Util.percentile(scores, 95),
      avgComments: Util.average(comments),
      avgUpvoteRatio: ratios.length ? Util.average(ratios) : null,
      topPost, lowPost,
      bySubreddit, byHour, byDow, avgScoreByHour, avgVelocityByHour,
      flairs, authors,
    };
  };

  /* ============================================================
     5. PROFILE  (composite snapshot of any post set)
     ============================================================ */

  Analysis.profile = function (posts, opts) {
    opts = opts || {};
    const agg = Analysis.aggregate(posts);
    const sentiment = Analysis.aggregateSentiment(posts);
    const keywords = Analysis.extractKeywords(posts, 25);
    const bigrams = Analysis.extractBigrams(posts, 12);
    const themes = Analysis.themes(posts, { uniTop: 10, biTop: 6, minPosts: 2 });

    let bestHour = -1, bestHourVal = -Infinity;
    for (let h = 0; h < 24; h++) {
      if (agg.byHour[h] > 0 && agg.avgScoreByHour[h] > bestHourVal) {
        bestHourVal = agg.avgScoreByHour[h];
        bestHour = h;
      }
    }
    /* Velocity-corrected best hour. Uses score-per-hour-of-age
     * instead of raw averages so the result isn't dominated by
     * the older posts in the snapshot. Pair this with the raw
     * `bestHour` in the UI so the user can see whether the two
     * agree (genuine peak) or disagree (the raw signal is just
     * a survivorship artifact).
     *
     * Skip hours with < 2 samples — single-post hours are too
     * noisy to call a "peak". */
    let bestHourByVelocity = -1, bvVal = -Infinity;
    for (let h = 0; h < 24; h++) {
      if (agg.byHour[h] >= 2 && agg.avgVelocityByHour[h] > bvVal) {
        bvVal = agg.avgVelocityByHour[h];
        bestHourByVelocity = h;
      }
    }
    /* Fall back to >= 1 if EVERY hour only has one sample (small
     * loaded windows), so the field still has a value. */
    if (bestHourByVelocity === -1) {
      for (let h = 0; h < 24; h++) {
        if (agg.byHour[h] >= 1 && agg.avgVelocityByHour[h] > bvVal) {
          bvVal = agg.avgVelocityByHour[h];
          bestHourByVelocity = h;
        }
      }
    }
    let bestDow = 0, bestDowVal = -1;
    for (let d = 0; d < 7; d++) {
      if (agg.byDow[d] > bestDowVal) { bestDowVal = agg.byDow[d]; bestDow = d; }
    }

    let style;
    const ratio = agg.avgComments > 0 ? agg.avgScore / agg.avgComments : 0;
    if (ratio >= 50) style = "shareable";
    else if (ratio > 0 && ratio <= 8) style = "discussion";
    else style = "mixed";

    let reception;
    const r = agg.avgUpvoteRatio;
    if (r == null) reception = "unknown";
    else if (r >= 0.9) reception = "warm";
    else if (r >= 0.75) reception = "healthy";
    else if (r >= 0.6) reception = "mixed";
    else reception = "contentious";

    const subs = Object.keys(agg.bySubreddit);
    const topPostsBy = (k) => posts.slice().sort((a, b) => (b[k] || 0) - (a[k] || 0)).slice(0, 5);

    /* Subreddit health metrics — driven by the loaded post window.
     *   - velocityPerHour : how many posts were submitted per hour
     *     across the loaded window (= count / span_hours). Distinguishes
     *     busy subs (>10/hr) from quiet ones (<0.5/hr).
     *   - karmaP10/P50/P90 : score distribution. Tells you whether
     *     this sub mostly produces small posts with rare breakouts
     *     (high P90/P50 ratio) or broadly engaged content (flatter).
     *   - quietHours : hour-of-day buckets with zero loaded posts —
     *     literal dead zones. Useful as a "don't post here now" signal.
     *   - stickyShare : fraction of loaded posts that are mod-pinned;
     *     high values mean baseline metrics are inflated by mod boost.
     *   - removedShare : fraction visibly [removed]; high values mean
     *     the sub aggressively moderates (or your scrape missed
     *     deletions).
     * NSFW share is also exposed for content-filter use. */
    const submitTimes = posts.map((p) => Number(p.created_utc) || 0).filter((t) => t > 0).sort((a, b) => a - b);
    let velocityPerHour = 0, spanHours = 0;
    if (submitTimes.length >= 2) {
      spanHours = (submitTimes[submitTimes.length - 1] - submitTimes[0]) / 3600;
      if (spanHours > 0.1) velocityPerHour = submitTimes.length / spanHours;
    }
    const sortedScores = posts.map((p) => p.score || 0).slice().sort((a, b) => a - b);
    function pct(arr, p) {
      if (!arr.length) return 0;
      const i = Math.max(0, Math.min(arr.length - 1, Math.floor((arr.length - 1) * p / 100)));
      return arr[i];
    }
    const karmaP10 = pct(sortedScores, 10);
    const karmaP50 = pct(sortedScores, 50);
    const karmaP90 = pct(sortedScores, 90);
    /* Skew = how much P90 dwarfs P50 (1.0 = flat distribution,
     * higher = a few breakouts dominate). Floor at 1 to avoid
     * inflated numbers from sub with median 0. */
    const karmaSkew = karmaP50 > 0 ? karmaP90 / karmaP50 : 1;
    const quietHours = [];
    for (let h = 0; h < 24; h++) if (!agg.byHour[h]) quietHours.push(h);
    const stickyShare = agg.count ? posts.filter((p) => p.stickied).length / agg.count : 0;
    const removedShare = agg.count ? posts.filter((p) => p.removed).length / agg.count : 0;
    const nsfwShare = agg.count ? posts.filter((p) => p.over_18).length / agg.count : 0;

    return {
      label: opts.label || "Posts",
      count: agg.count,
      totalScore: agg.totalScore,
      totalComments: agg.totalComments,
      avgScore: agg.avgScore,
      medianScore: agg.medianScore,
      avgComments: agg.avgComments,
      avgUpvoteRatio: agg.avgUpvoteRatio,
      sentiment,
      keywords, bigrams, themes,
      bestHour, bestDow,
      bestHourByVelocity,
      byHour: agg.byHour,
      byDow: agg.byDow,
      avgScoreByHour: agg.avgScoreByHour,
      avgVelocityByHour: agg.avgVelocityByHour,
      style, reception,
      ratio,
      /* New health metrics (PR 2) */
      velocityPerHour,
      spanHours,
      karmaP10, karmaP50, karmaP90, karmaSkew,
      quietHours,
      stickyShare, removedShare, nsfwShare,
      subreddits: subs,
      bySubreddit: agg.bySubreddit,
      topByScore: topPostsBy("score"),
      topByComments: topPostsBy("num_comments"),
      topPost: agg.topPost,
      lowPost: agg.lowPost,
    };
  };

  /* ============================================================
     6. PER-SUBREDDIT PROFILES
     ============================================================ */

  Analysis.subredditProfiles = function (posts) {
    const groups = {};
    for (const p of posts) {
      const s = (p.subreddit || "").toLowerCase();
      if (!s) continue;
      if (!groups[s]) groups[s] = [];
      groups[s].push(p);
    }
    const out = {};
    for (const [s, list] of Object.entries(groups)) {
      out[s] = Analysis.profile(list, { label: "r/" + s });
      out[s].subreddit = s;
    }
    return out;
  };

  /* ============================================================
     6a. POSTING TIMES, PER SUBREDDIT
     ------------------------------------------------------------
     Pooling every loaded post into one 24-hour histogram produces a
     "best hour" that is true of no community in particular. r/politics
     and a state organising sub keep different hours, and averaging
     them lands somewhere neither audience is awake.

     So the timing model is per subreddit from the start. Each row is
     one community's own peak, measured against that community's own
     average — a lift of +40% in a small sub is a real finding even if
     its absolute scores never approach the big sub's floor.

     The cross-sub summary only exists to answer "do these communities
     actually agree?", and it reports the spread rather than hiding it
     behind a single number.

     The estimator itself lives in js/timing.js, which fits a smoothed
     log-space model per community and returns the statistics behind
     each recommendation. These are thin delegates so that the rest of
     the analysis layer keeps one entry point for "when should I post".
     ============================================================ */

  /* Circular distance between two hours, in hours (0..12). 23:00 and
     01:00 are two hours apart, not twenty-two. */
  function hourDistance(a, b) {
    const d = Math.abs(a - b) % 24;
    return Math.min(d, 24 - d);
  }

  /* opts.minSample — posts a sub needs before its peak is reported at
     all (default 4). Below that a single lucky post decides the hour. */
  Analysis.postingTimes = function (posts, opts) {
    opts = opts || {};
    const model = Timing.model(posts, opts);
    /* opts.raw — return the unconstrained fit so a caller can re-apply
       the dual-ended availability slider without refitting. */
    if (opts.raw) return model;
    const avail = opts.availability !== undefined
      ? opts.availability
      : (window.AppState ? AppState.postingAvail : null);
    return window.Timing && Timing.constrainModel
      ? Timing.constrainModel(model, avail)
      : model;
  };

  /* Wrap a set of per-sub timing rows in the cross-sub summary. Kept
     separate so callers can assemble rows from more than one source —
     the campaign workspace mixes a campaign's own posts with the
     subreddit's ambient rhythm where the campaign is too thin. */
  Analysis.summarizePostingTimes = function (rows, opts) {
    return Timing.summarize(rows, opts);
  };

  Analysis.hourDistance = hourDistance;

  /* ============================================================
     6b. DASHBOARD BUNDLE
     ------------------------------------------------------------
     Every chart-ready derivation for an arbitrary set of posts, in
     one call. The individual analysers were always pure functions
     over a post array, but the app only ever assembled them inline
     inside its global re-render — which is why campaigns had tables
     and prose while the global tabs had all the charts.

     Passing a subset here (one campaign's posts, or one subreddit's
     slice of them) yields exactly the same shape, so the same
     renderers work at any scope.
     ============================================================ */

  Analysis.dashboard = function (posts, opts) {
    opts = opts || {};
    const list = posts || [];
    const agg = Analysis.aggregate(list);
    const sentiment = Analysis.aggregateSentiment(list);

    const bundle = {
      posts: list,
      count: list.length,
      agg: agg,
      sentiment: sentiment,
      trend: Analysis.engagementTrend(list),
      timeline: Analysis.bucketByTimePerSub(list, { window: opts.window || "all" }),
      histogram: Analysis.scoreHistogram(list, opts.bins || 12),
      keywords: Analysis.extractKeywords(list, opts.keywordLimit || 30),
    };

    /* The heavier derivations are opt-out: a per-subreddit card wants
     * charts but not a full theme clustering pass, and running themes
     * across a dozen sub cards is the difference between an instant
     * render and a visible stall. */
    if (opts.themes !== false) bundle.themes = Analysis.themes(list);
    if (opts.profile !== false) bundle.profile = Analysis.profile(list, { label: opts.label });
    if (opts.subProfiles) bundle.subProfiles = Analysis.subredditProfiles(list);

    return bundle;
  };

  /* Group posts by subreddit and build a full dashboard bundle for each
   * one, sorted by whichever metric matters to the caller. This is what
   * the campaign workspace uses to chart every community a campaign
   * touched. */
  Analysis.perSubredditDashboards = function (posts, opts) {
    opts = opts || {};
    const groups = new Map();
    for (const p of posts || []) {
      const key = (p.subreddit || "").toLowerCase();
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { name: p.subreddit, posts: [] });
      groups.get(key).posts.push(p);
    }

    const out = [];
    for (const [key, group] of groups.entries()) {
      const bundle = Analysis.dashboard(group.posts, {
        window: opts.window || "all",
        themes: opts.themes === true,
        label: "r/" + group.name,
        keywordLimit: opts.keywordLimit || 12,
        bins: opts.bins || 8,
      });
      bundle.subreddit = group.name;
      bundle.key = key;
      out.push(bundle);
    }

    const sortBy = opts.sortBy || "score";
    out.sort((a, b) => {
      if (sortBy === "posts") return b.count - a.count;
      if (sortBy === "comments") return b.agg.totalComments - a.agg.totalComments;
      return b.agg.totalScore - a.agg.totalScore;
    });
    return out;
  };

  /* ============================================================
     7. CAMPAIGN PROFILE (same builder, just labelled)
     ============================================================ */

  Analysis.campaignProfile = function (posts, campaign) {
    const profile = Analysis.profile(posts || [], {
      label: campaign && campaign.name ? campaign.name : "Campaign",
    });
    profile.campaignId = campaign && campaign.id;
    profile.campaignName = campaign && campaign.name;
    return profile;
  };

  /* ============================================================
     7b. TIMING & ENGAGEMENT TREND HELPERS
     ============================================================ */

  /* Cosine similarity between two 24-element hour-of-day distributions.
   * 1.0 = identical posting rhythm, 0 = completely disjoint hours. */
  Analysis.timeAlignment = function (a, b) {
    if (!a || !b) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let h = 0; h < 24; h++) {
      const ah = a[h] || 0, bh = b[h] || 0;
      dot += ah * bh;
      na += ah * ah;
      nb += bh * bh;
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  };

  /* Day-of-week alignment, same idea. */
  Analysis.dowAlignment = function (a, b) {
    if (!a || !b) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let d = 0; d < 7; d++) {
      const ad = a[d] || 0, bd = b[d] || 0;
      dot += ad * bd;
      na += ad * ad;
      nb += bd * bd;
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  };

  /* Engagement-trend over time: split posts in half by created_utc and
   * compare the older half's avg score to the newer half's. Returns
   * { direction: 'rising'/'flat'/'declining', slope, recentAvg, olderAvg }.
   * 'slope' is normalised so a campaign-quality reading is robust to
   * absolute score differences between subs. */
  Analysis.engagementTrend = function (posts) {
    if (!posts || posts.length < 4) {
      return { direction: "flat", slope: 0, recentAvg: 0, olderAvg: 0 };
    }
    const sorted = posts.slice().filter((p) => p.created_utc).sort((a, b) => a.created_utc - b.created_utc);
    if (sorted.length < 4) return { direction: "flat", slope: 0, recentAvg: 0, olderAvg: 0 };
    const half = Math.floor(sorted.length / 2);
    const older = sorted.slice(0, half);
    const recent = sorted.slice(half);
    const olderAvg = Util.average(older.map((p) => p.score || 0));
    const recentAvg = Util.average(recent.map((p) => p.score || 0));
    const baseline = Math.max(1, olderAvg);
    const slope = (recentAvg - olderAvg) / baseline;
    let direction;
    if (slope > 0.20) direction = "rising";
    else if (slope < -0.20) direction = "declining";
    else direction = "flat";
    return { direction, slope, recentAvg, olderAvg };
  };

  /* ============================================================
     8. TARGETING RECOMMENDER
     ------------------------------------------------------------
     Given a campaign profile and a map of subreddit profiles,
     score each subreddit on its fit for the campaign's content.
     Returns a ranked list with composite score and reasoning.
     ============================================================ */

  Analysis.recommendTargets = function (campaignProfile, subProfiles, opts) {
    opts = opts || {};
    /* Default cap raised to 200 so the renderer has plenty of
     * material to paginate over. Callers can override down for
     * narrow uses (e.g. composer's "From recommended" wants the
     * top ~12 to seed its target list). */
    const limit = opts.limit != null ? opts.limit : 200;
    const subs = Object.values(subProfiles || {});
    if (!subs.length || !campaignProfile || !campaignProfile.count) return [];

    const campaignSubs = new Set(campaignProfile.subreddits || []);
    const camKeys = new Set(campaignProfile.keywords.map((k) => k.word));
    const camPhrases = new Set(campaignProfile.bigrams.map((b) => b.phrase));
    const camSent = campaignProfile.sentiment.average;

    const maxCount = Math.max(1, ...subs.map((s) => s.count));

    const out = subs.map((sp) => {
      const subKeys = new Set(sp.keywords.map((k) => k.word));
      const subPhrases = new Set(sp.bigrams.map((b) => b.phrase));
      const wOverlap = intersect(camKeys, subKeys);
      const pOverlap = intersect(camPhrases, subPhrases);
      const wUnion = union(camKeys, subKeys).size || 1;
      const pUnion = union(camPhrases, subPhrases).size || 1;
      const themeJaccard = (wOverlap.size + 2 * pOverlap.size) / (wUnion + 2 * pUnion);

      const sentDiff = Math.abs(camSent - sp.sentiment.average);
      const sentMatch = Math.max(0, 1 - sentDiff / 1.0);

      const reception = sp.avgUpvoteRatio == null ? 0.5 : sp.avgUpvoteRatio;
      const activity = Math.log(sp.count + 1) / Math.log(maxCount + 1);

      let style = 0.5;
      if (sp.style === campaignProfile.style) style = 1.0;
      else if (sp.style === "mixed" || campaignProfile.style === "mixed") style = 0.7;
      else style = 0.3;

      /* New trend-aware dimensions */
      const hourAlign = Analysis.timeAlignment(campaignProfile.byHour, sp.byHour);
      const dowAlign = Analysis.dowAlignment(campaignProfile.byDow, sp.byDow);
      const trend = sp._trend || (sp._trend = (function () {
        /* The profile() builder doesn't have access to raw posts; we attach
         * a placeholder here. The richer `recommendTargetsWithTrend` path
         * sets _trend up front. */
        return { direction: "flat", slope: 0 };
      })());
      const trendBoost = trend.direction === "rising" ? 1 : trend.direction === "flat" ? 0.5 : 0;

      const composite = clamp01(
        0.30 * Math.min(1, themeJaccard * 4) +
        0.18 * sentMatch +
        0.15 * reception +
        0.08 * activity +
        0.08 * style +
        0.13 * hourAlign +
        0.04 * dowAlign +
        0.04 * trendBoost
      );
      const score = Math.round(composite * 100);

      const alreadyTargeted = campaignSubs.has(sp.subreddit);
      const sharedKeys = Array.from(wOverlap).slice(0, 6);
      const sharedPhrases = Array.from(pOverlap).slice(0, 4);

      const reasons = [];
      if (sharedPhrases.length) reasons.push(`shared themes <em>${sharedPhrases.map(htmlSafe).join(", ")}</em>`);
      if (sharedKeys.length) reasons.push(`overlapping keywords <em>${sharedKeys.map(htmlSafe).join(", ")}</em>`);
      reasons.push(`audience reception ${labelReception(reception)} (${(reception * 100).toFixed(0)}% upvote ratio)`);
      reasons.push(`sentiment ${describeSentDelta(camSent, sp.sentiment.average)}`);
      reasons.push(`engagement style: <strong>${sp.style}</strong> vs campaign <strong>${campaignProfile.style}</strong>`);
      reasons.push(`posting-time fit: <strong>${(hourAlign * 100).toFixed(0)}%</strong> hour-of-day overlap`);
      if (trend.direction === "rising") reasons.push(`<span class="badge good">engagement trending up</span> (recent avg ${Util.fmtNum(trend.recentAvg)} vs older ${Util.fmtNum(trend.olderAvg)})`);
      else if (trend.direction === "declining") reasons.push(`<span class="badge bad">engagement trending down</span> (recent avg ${Util.fmtNum(trend.recentAvg)} vs older ${Util.fmtNum(trend.olderAvg)})`);
      if (sp.bestHour >= 0) reasons.push(`sub's peak hour <code>${String(sp.bestHour).padStart(2, "0")}:00</code> ${Util.escapeHtml(Util.getTzLabel())}`);
      if (alreadyTargeted) reasons.unshift(`<span class="badge info">already targeted</span>`);

      return {
        subreddit: sp.subreddit,
        score,
        composite,
        themeJaccard,
        sentMatch,
        reception,
        activity,
        styleMatch: style,
        hourAlign,
        dowAlign,
        trend,
        alreadyTargeted,
        sharedKeys,
        sharedPhrases,
        profile: sp,
        reasons,
      };
    });

    out.sort((a, b) => {
      // already-targeted subs go to the bottom
      if (a.alreadyTargeted !== b.alreadyTargeted) return a.alreadyTargeted ? 1 : -1;
      return b.score - a.score;
    });
    return out.slice(0, limit);
  };

  function intersect(a, b) {
    const out = new Set();
    for (const v of a) if (b.has(v)) out.add(v);
    return out;
  }
  function union(a, b) {
    const out = new Set(a);
    for (const v of b) out.add(v);
    return out;
  }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function htmlSafe(s) { return Util ? Util.escapeHtml(s) : String(s); }
  function labelReception(r) {
    if (r >= 0.9) return "warm";
    if (r >= 0.75) return "healthy";
    if (r >= 0.6) return "mixed";
    if (r > 0) return "contentious";
    return "unknown";
  }
  function describeSentDelta(a, b) {
    const d = Math.abs(a - b);
    if (d < 0.1) return "well aligned";
    if (d < 0.3) return "modestly aligned";
    return "diverging — consider reframing";
  }

  /* ============================================================
     9. TITLE QUALITY SCORER
     ============================================================ */

  Analysis.titleQuality = function (title) {
    title = String(title || "").trim();
    const len = title.length;
    const words = title.split(/\s+/).filter(Boolean);
    const wc = words.length;
    const factors = [];
    let score = 100;

    if (len === 0) return { score: 0, factors: [{ label: "Empty title", delta: -100, ok: false }] };

    if (len < 25) { factors.push({ label: "Too short (<25 chars)", delta: -15, ok: false }); score -= 15; }
    else if (len <= 80) factors.push({ label: "Length sweet spot 25–80 chars", delta: +5, ok: true });
    else if (len <= 120) factors.push({ label: "A touch long (80–120 chars)", delta: -5, ok: false });
    else { factors.push({ label: "Very long (>120 chars)", delta: -15, ok: false }); score -= 15; }

    if (wc < 5) { factors.push({ label: "Few words (<5)", delta: -10, ok: false }); score -= 10; }
    else if (wc >= 6 && wc <= 18) factors.push({ label: "Word count 6–18", delta: +5, ok: true });
    else if (wc > 22) { factors.push({ label: "Wordy (>22 words)", delta: -8, ok: false }); score -= 8; }

    const capsWords = words.filter((w) => w.length > 2 && w === w.toUpperCase()).length;
    const capsRatio = wc ? capsWords / wc : 0;
    if (capsRatio > 0.4) { factors.push({ label: "Excessive ALL-CAPS", delta: -15, ok: false }); score -= 15; }
    else if (capsRatio > 0) factors.push({ label: "Some caps for emphasis", delta: 0, ok: true });

    if (/\?\s*$/.test(title)) { factors.push({ label: "Question — invites discussion", delta: +5, ok: true }); score += 5; }
    if (/!{2,}/.test(title)) { factors.push({ label: "Multiple exclamation marks", delta: -5, ok: false }); score -= 5; }
    if (/\b\d{1,4}\b/.test(title)) { factors.push({ label: "Includes a number — concrete", delta: +3, ok: true }); score += 3; }
    if (/[\[\(].+?[\]\)]/.test(title)) { factors.push({ label: "Bracketed tag — scannable", delta: +2, ok: true }); score += 2; }

    const sent = Analysis.scoreSentiment(title);
    if (Math.abs(sent.score) >= 0.4) { factors.push({ label: `Strong ${sent.score > 0 ? "positive" : "negative"} framing`, delta: +4, ok: true }); score += 4; }
    else if (Math.abs(sent.score) >= 0.15) factors.push({ label: `Mild ${sent.score > 0 ? "positive" : "negative"} framing`, delta: +2, ok: true });

    const clickbaity = /\b(you won't believe|shocking|literally everyone|this one trick|destroyed|owned|epic|legendary)\b/i;
    if (clickbaity.test(title)) { factors.push({ label: "Clickbait phrasing", delta: -10, ok: false }); score -= 10; }

    score = Math.max(0, Math.min(100, score));
    let band;
    if (score >= 80) band = "excellent";
    else if (score >= 65) band = "good";
    else if (score >= 50) band = "okay";
    else band = "weak";

    return { score, band, factors, length: len, words: wc, capsRatio, sentiment: sent.score };
  };

  /* ============================================================
     10. TOP vs BOTTOM POST COMPARISON
     ============================================================ */

  Analysis.compareTopBottom = function (posts) {
    if (!posts || posts.length < 4) return null;
    const sorted = posts.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
    const n = Math.min(3, Math.floor(sorted.length / 3));
    const top = sorted.slice(0, n);
    const bottom = sorted.slice(-n);

    function summarize(set) {
      const titleLengths = set.map((p) => (p.title || "").length);
      const wordCounts = set.map((p) => (p.title || "").split(/\s+/).filter(Boolean).length);
      const sent = Analysis.aggregateSentiment(set);
      const hours = set.map((p) => p.created_utc ? new Date(p.created_utc * 1000).getHours() : null).filter((x) => x != null);
      const ratios = set.map((p) => p.upvote_ratio).filter((x) => x != null);
      return {
        avgLen: Util.average(titleLengths),
        avgWords: Util.average(wordCounts),
        avgSent: sent.average,
        avgHour: hours.length ? Util.average(hours) : null,
        avgUpvoteRatio: ratios.length ? Util.average(ratios) : null,
        avgComments: Util.average(set.map((p) => p.num_comments || 0)),
        avgScore: Util.average(set.map((p) => p.score || 0)),
        examples: set.slice(0, 3),
      };
    }

    const t = summarize(top);
    const b = summarize(bottom);

    const insights = [];
    if (Math.abs(t.avgLen - b.avgLen) > 10) {
      insights.push(`Top posts have ${t.avgLen > b.avgLen ? "longer" : "shorter"} titles on average (${Math.round(t.avgLen)} vs ${Math.round(b.avgLen)} chars).`);
    }
    if (Math.abs(t.avgSent - b.avgSent) > 0.15) {
      insights.push(`Sentiment differs noticeably: top posts average <strong>${t.avgSent.toFixed(2)}</strong> vs bottom <strong>${b.avgSent.toFixed(2)}</strong>.`);
    }
    if (t.avgHour != null && b.avgHour != null && Math.abs(t.avgHour - b.avgHour) > 3) {
      insights.push(`Top posts cluster around <strong>${pad2(Math.round(t.avgHour))}:00 ${Util.escapeHtml(Util.getTzLabel())}</strong>, low performers around <strong>${pad2(Math.round(b.avgHour))}:00 ${Util.escapeHtml(Util.getTzLabel())}</strong>.`);
    }
    if (t.avgUpvoteRatio != null && b.avgUpvoteRatio != null && Math.abs(t.avgUpvoteRatio - b.avgUpvoteRatio) > 0.05) {
      insights.push(`Audience reception splits: ${(t.avgUpvoteRatio * 100).toFixed(0)}% upvote ratio for top vs ${(b.avgUpvoteRatio * 100).toFixed(0)}% for bottom.`);
    }
    if (Math.abs(t.avgComments - b.avgComments) > 5) {
      insights.push(`Comment activity is ${t.avgComments > b.avgComments ? "much higher" : "lower"} on top posts (${Math.round(t.avgComments)} vs ${Math.round(b.avgComments)}).`);
    }
    if (!insights.length) insights.push("Top and bottom posts look similar across the measurable dimensions — content/topic matters more than timing here.");

    return { top: t, bottom: b, insights };
  };
  function pad2(n) { return String(n).padStart(2, "0"); }

  /* ============================================================
     11. CROSS-POST DETECTION (existing API kept stable)
     ============================================================ */

  /* Title fingerprint for fuzzy cross-post grouping.
   *
   * Catches near-duplicates like:
   *   "BREAKING: Senator X says Y"   ->  senator x says y
   *   "Senator X says Y - per WaPo"  ->  senator x says y per wapo
   *   "[VIDEO] Senator X says Y!"    ->  video senator x says y
   *
   * The fingerprint:
   *   1. lowercases
   *   2. strips leading bracket-prefixes ([BREAKING], (UPDATE), etc.)
   *   3. removes punctuation
   *   4. collapses whitespace
   *   5. drops common stopwords
   *   6. takes the first 8 content words
   * Two titles share a group when their 8-word fingerprints match.
   * That's stricter than full Levenshtein (which would balloon to
   * O(N^2) on 1000+ posts) but loose enough to catch the obvious
   * near-dupes. */
  const FINGERPRINT_STOP = new Set([
    "a","an","the","of","to","in","on","at","for","with","by","from","is",
    "are","was","were","be","been","being","this","that","these","those",
    "it","its","as","and","or","but","not","no","so","if","then","than",
    "do","did","does","done","has","have","had","just","new","will","would",
    "should","can","could","may","might","must","more","most","much","many",
    "i","me","my","we","our","us","you","your","they","them","their","he",
    "she","his","her","reddit","watch","video","breaking","update","news",
  ]);
  function titleFingerprint(title) {
    if (!title) return "";
    let s = String(title).toLowerCase();
    /* Strip leading bracket prefixes like [BREAKING] / (UPDATE) / etc. —
     * repeat to peel multiple stacked prefixes ("[NSFW][VIDEO] …"). */
    for (let i = 0; i < 3; i++) {
      s = s.replace(/^[\s]*[\[\(\{]([^\]\)\}]{1,40})[\]\)\}][\s:,-]*/g, " ");
    }
    /* Strip leading "BREAKING:" / "UPDATE:" / "EXCLUSIVE:" without
     * brackets, and similar all-caps prefix shouts. */
    s = s.replace(/^\s*(?:breaking|update|exclusive|news|video|watch|just in)[\s:—-]+/gi, " ");
    /* Strip punctuation, normalise whitespace. */
    s = s.replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
    if (!s) return "";
    const words = s.split(" ").filter((w) => w && !FINGERPRINT_STOP.has(w));
    /* Use the first 4 content words as the matching key. Shorter keys
     * = more aggressive grouping. 4 is enough to disambiguate truly
     * different stories while still catching titles that diverge in
     * the trailing suffix ("…— per WaPo", "…today", "…explained",
     * "…now"). Hash-based grouping is O(N); fancier fuzzy options
     * (Levenshtein, Jaccard over n-grams) would be O(N²) and not
     * tractable on a 7,000-post dashboard. */
    return words.slice(0, 4).join(" ");
  }
  Analysis.titleFingerprint = titleFingerprint;

  /* A post wearing a removal placeholder instead of a title has no
   * title to match on. Grouping on the placeholder text collects every
   * removed post in the dataset into one bogus story. Posts here can
   * still be grouped by URL or by crosspost parent, which are real
   * evidence of the same content; the placeholder is not.
   *
   * The string test covers posts restored from a cache written before
   * normalisePost started flagging them. */
  function placeholderTitle(p) {
    if (p.title_placeholder && !p.title_source) return true;
    if (p.title_source) return false;
    return typeof Reddit !== "undefined" && Reddit.isPlaceholderTitle
      ? Reddit.isPlaceholderTitle(p.title)
      : false;
  }
  Analysis.isPlaceholderTitle = placeholderTitle;

  Analysis.detectCrossPosts = function (posts) {
    const byTitle = new Map();
    const byUrl = new Map();
    /* Native Reddit crossposts (data.crosspost_parent) — group all
     * children of the same parent regardless of title/URL. */
    const byNativeXp = new Map();
    for (const p of posts) {
      /* Fuzzy title key (see titleFingerprint above). Falls back to
       * the cleaned full title if the fingerprint comes out empty
       * (e.g. all-stopwords title). */
      const fp = placeholderTitle(p)
        ? ""
        : (titleFingerprint(p.title) ||
           (p.title || "").toLowerCase().replace(/\s+/g, " ").trim());
      if (fp) {
        if (!byTitle.has(fp)) byTitle.set(fp, []);
        byTitle.get(fp).push(p);
      }
      if (p.url && !p.is_self) {
        /* Use the canonicalised URL when available (strips tracking
         * params, collapses youtu.be / m.youtube.com / x.com / etc.).
         * Falls back to the legacy split-on-? for posts loaded from
         * a pre-canonicalisation cache. */
        const u = p.url_canonical || p.url.split("?")[0];
        if (!byUrl.has(u)) byUrl.set(u, []);
        byUrl.get(u).push(p);
      }
      if (p.crosspost_parent_id) {
        const k = p.crosspost_parent_id;
        if (!byNativeXp.has(k)) byNativeXp.set(k, []);
        byNativeXp.get(k).push(p);
      }
    }
    const groups = [];
    function consider(map, kind) {
      for (const [key, list] of map.entries()) {
        const subs = new Set(list.map((p) => (p.subreddit || "").toLowerCase()));
        if (subs.size >= 2) {
          groups.push({
            kind, key,
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
    consider(byNativeXp, "native");
    const seen = new Set();
    /* Sort:
     *   1) spread (number of distinct subs the content is in) DESC
     *      — content cross-posted to 5 subs ranks above content with
     *      bigger raw upvotes but only on 2 subs, since it's the
     *      better signal of a deliberate cross-post campaign.
     *   2) totalScore DESC as the tie-breaker within the same spread.
     */
    return groups
      .sort((a, b) => {
        const ds = b.subs.length - a.subs.length;
        if (ds !== 0) return ds;
        return b.totalScore - a.totalScore;
      })
      .filter((g) => {
        const sig = g.posts.map((p) => p.id).sort().join(",");
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
      });
  };

  /* ============================================================
     12. POSTING BRIEFING
     ============================================================ */

  const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

  function medianOf(values) {
    if (!values.length) return 0;
    const s = values.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  /* Cut a headline on a word boundary so it reads as shortened rather
     than severed. */
  function headline(text, max) {
    const t = String(text || "").trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const space = cut.lastIndexOf(" ");
    return (space > max * 0.6 ? cut.slice(0, space) : cut) + "…";
  }

  /* The dashboard's at-a-glance summary.
   *
   * This deliberately does not narrate the KPI row sitting directly
   * above it. Totals, medians and percentiles are already on screen as
   * numbers, and restating them in prose made the card four dense
   * paragraphs that nobody could scan. Nor does it rank subreddits by
   * total score, which mostly measures how many posts you happened to
   * load rather than anything about the communities.
   *
   * Every line answers "where, when or what should I post", is scoped
   * to a named community rather than pooled across them, and is
   * omitted entirely when the data cannot support it. Returns
   * { label, value, note } rows; `value` may carry inline markup and
   * is already escaped. */
  Analysis.postingBriefing = function (posts, opts) {
    opts = opts || {};
    const list = posts || [];
    if (!list.length) return [];

    const esc = Util.escapeHtml;
    const agg = opts.agg || Analysis.aggregate(list);
    const timing = opts.timing || Analysis.postingTimes(list, { minSample: 4 });
    const ranked = timing.ranked || [];
    const tz = esc(Util.getTzLabel());
    const out = [];

    /* ---- When ----
       This row used to name three communities and defer the rest to
       the Timing tab, which meant the single most actionable thing on
       the dashboard was three-quarters hidden behind a tab. It now
       leads with the next slot to actually hit, lists the
       best-evidenced communities underneath, and lets a row through to
       that community's chart — the whole picture at a glance, without
       reproducing the tab's charts. */
    const measured = timing.measured || [];
    if (!ranked.length) {
      out.push({
        label: "When",
        value: measured.length
          ? "Posting time is not what's holding these back"
          : "Not enough posts from any one community yet",
        note: measured.length
          ? `${measured.length === 1 ? "The one community" : `All ${measured.length} communities`} with enough posts came back flat — their good hours look no different from chance`
          : `a posting slot needs ${timing.minSample}+ posts from the same subreddit before it means anything`,
      });
    } else {
      const lead = timing.nextUp;
      out.push({
        label: "When",
        /* "Post now" when the recommended window is already running.
           The alternative — naming the peak minute and how far off it
           is — told people to wait from inside the very window being
           recommended. */
        value: lead && lead.next
          ? (lead.next.open
            ? `<strong>Post now</strong> in r/${esc(lead.subreddit)} — window open until ${esc(lead.next.closesAt)}`
            : `<strong>${esc(lead.next.label)}</strong> in r/${esc(lead.subreddit)}, ${esc(lead.next.inLabel)}`)
          : `${ranked.length} communit${ranked.length === 1 ? "y has" : "ies have"} a slot worth waiting for`,
        note: (timing.agree
          ? `all ${ranked.length} peak within ${timing.spreadMinutes} minutes of each other, so one slot serves them`
          : ranked.length === 1
            ? `measured against this community's own typical post`
            : `each community keeps its own clock — peaks span ${timing.spread}h`)
          + ` · times in ${tz}`
          + (ranked.length > 1 ? ` · best-evidenced first, tap one for its chart` : ""),
        timing: timing,
      });
    }

    /* ---- Where ---- */
    const groups = new Map();
    for (const p of list) {
      const key = (p.subreddit || "").toLowerCase();
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { name: p.subreddit, scores: [], comments: [] });
      const g = groups.get(key);
      g.scores.push(p.score || 0);
      g.comments.push(p.num_comments || 0);
    }

    /* Medians, not totals: a community does not become the better place
       to post because more of its posts happen to be loaded. */
    const MIN_SUB_POSTS = 5;
    const subs = [];
    for (const g of groups.values()) {
      if (g.scores.length < MIN_SUB_POSTS) continue;
      subs.push({
        name: g.name,
        medScore: medianOf(g.scores),
        medComments: medianOf(g.comments),
      });
    }

    /* A community only earns a line by being clearly ahead. Naming a
       winner that beats the runner-up by a rounding error would be
       advice the data cannot back. */
    const MARGIN = 1.25;

    if (subs.length >= 2) {
      const byReach = subs.slice().sort((a, b) => b.medScore - a.medScore);
      const byTalk = subs.slice().sort((a, b) => b.medComments - a.medComments);
      const reach = byReach[0];
      const talk = byTalk[0];
      const reachWins = reach.medScore >= byReach[1].medScore * MARGIN;
      const talkWins = talk.name !== reach.name && talk.medComments >= byTalk[1].medComments * MARGIN;

      if (reachWins) {
        out.push({
          label: "Best reach",
          value: `r/${esc(reach.name)}`,
          note: `${Util.fmtNum(reach.medScore)} upvotes on a typical post, against ${Util.fmtNum(byReach[1].medScore)} in r/${esc(byReach[1].name)}`
            + (talk.name === reach.name ? " — and it leads on discussion too" : ""),
        });
      }

      if (talkWins) {
        out.push({
          label: "Most discussion",
          value: `r/${esc(talk.name)}`,
          note: `${Util.fmtNum(talk.medComments)} comments on a typical post, against ${Util.fmtNum(reach.medComments)} in r/${esc(reach.name)}`,
        });
      }
    }

    /* ---- Reception ---- */
    if (agg.avgUpvoteRatio != null) {
      const r = agg.avgUpvoteRatio;
      const word = r >= 0.9 ? "strongly positive" : r >= 0.75 ? "healthy" : r >= 0.6 ? "mixed" : "contentious";
      /* No note when the number is fine on its own — a line of
         reassurance is one more line to read for no decision. */
      const note = r >= 0.75 ? ""
        : r >= 0.6 ? "tighter title framing is the cheapest thing to try"
          : "posts may be drawing brigading or off-topic replies";
      out.push({
        label: "Reception",
        value: `<strong>${Util.fmtPct(r)}</strong> upvote ratio — ${word}`,
        note: note,
      });
    }

    /* ---- What worked ---- */
    if (agg.topPost && agg.topPost.title) {
      const t = agg.topPost;
      const title = esc(headline(t.title, 90));
      out.push({
        label: "Best post",
        value: t.permalink
          ? `<a href="${esc(t.permalink)}" target="_blank" rel="noopener">${title}</a>`
          : title,
        note: `${Util.fmtNum(t.score)} upvotes and ${Util.fmtNum(t.num_comments)} comments in r/${esc(t.subreddit)}`,
      });
    }

    return out;
  };

  /* ============================================================
     13. TIME BUCKETING (existing API kept stable)
     ============================================================ */

  /* Adaptive time bucketing with per-subreddit breakdown.
   *
   * Picks a bucket size from a "nice" interval list so that the time
   * range of the loaded posts is split into ~30-40 buckets. This makes
   * the chart look right whether the data spans 6 hours or 6 months.
   *
   * Returns:
   *   {
   *     keys:    ["MM-DD HH:00", "MM-DD HH:00", ...],   labels in local TZ
   *     total:   [n, n, n, ...]                          combined posts/bucket
   *     bySub:   { sub: [n, n, n, ...] }                 per-sub series
   *     subs:    [sub, sub, ...]                         ordered by total volume
   *     bucketS: bucket width in seconds                 (for the chart subtitle)
   *     bucketLabel: human-readable bucket size          ("1 hour", "6 hours", "1 day")
   *   }
   */
  /* Find the smallest contiguous window covering `coverage` of the
   * timestamps. Used for the "Auto" picker so a few stale stickies in
   * a recent listing don't blow the x-axis out to 8 years. */
  function computeAutoWindow(posts, coverage, minS, maxS) {
    coverage = coverage == null ? 0.8 : coverage;
    minS = minS == null ? 24 * 3600 : minS;
    maxS = maxS == null ? 365 * 24 * 3600 : maxS;
    const times = posts.map((p) => p.created_utc).filter(Boolean).sort((a, b) => a - b);
    if (times.length < 4) return times.length ? { start: times[0], end: times[times.length - 1] } : null;
    const target = Math.max(2, Math.floor(times.length * coverage));
    let bestRange = Infinity, bestStart = times[0], bestEnd = times[times.length - 1];
    for (let i = 0; i + target - 1 < times.length; i++) {
      const r = times[i + target - 1] - times[i];
      if (r < bestRange) { bestRange = r; bestStart = times[i]; bestEnd = times[i + target - 1]; }
    }
    const span = Math.max(minS, Math.min(maxS, bestEnd - bestStart));
    return { start: bestEnd - span, end: bestEnd };
  }

  /* Map a window descriptor (auto / 1d / 3d / 7d / 30d / 90d / 1y / all)
   * to a [start, end] interval given the data's natural range. */
  function resolveWindow(posts, descriptor, dataMin, dataMax) {
    if (descriptor == null || descriptor === "all") return { start: dataMin, end: dataMax };
    if (descriptor === "auto") {
      const auto = computeAutoWindow(posts);
      if (!auto) return { start: dataMin, end: dataMax };
      return { start: Math.max(dataMin, auto.start), end: Math.min(dataMax, auto.end) };
    }
    let seconds;
    if (typeof descriptor === "number") seconds = descriptor;
    else {
      const m = String(descriptor).match(/^(\d+)([hdwmy])$/i);
      if (!m) return { start: dataMin, end: dataMax };
      const n = parseInt(m[1], 10), unit = m[2].toLowerCase();
      seconds = n * (unit === "h" ? 3600 : unit === "d" ? 86400 : unit === "w" ? 86400 * 7 : unit === "m" ? 86400 * 30 : 86400 * 365);
    }
    return { start: Math.max(dataMin, dataMax - seconds), end: dataMax };
  }

  Analysis.bucketByTimePerSub = function (posts, opts) {
    opts = opts || {};
    const targetBuckets = opts.targetBuckets || 32;

    if (!posts || !posts.length) {
      return { keys: [], total: [], bySub: {}, subs: [], bucketS: 3600, bucketLabel: "1 hour", windowLabel: "no data", droppedCount: 0, filteredCount: 0 };
    }

    let minT = Infinity, maxT = -Infinity;
    for (const p of posts) {
      if (!p.created_utc) continue;
      if (p.created_utc < minT) minT = p.created_utc;
      if (p.created_utc > maxT) maxT = p.created_utc;
    }
    if (!Number.isFinite(minT)) {
      return { keys: [], total: [], bySub: {}, subs: [], bucketS: 3600, bucketLabel: "1 hour", windowLabel: "no data", droppedCount: 0, filteredCount: 0 };
    }

    /* Apply the time-window filter. */
    const win = resolveWindow(posts, opts.window != null ? opts.window : "7d", minT, maxT);
    const filteredPosts = posts.filter((p) => p.created_utc >= win.start && p.created_utc <= win.end);
    if (!filteredPosts.length) {
      return { keys: [], total: [], bySub: {}, subs: [], bucketS: 3600, bucketLabel: "1 hour", windowLabel: "empty window", droppedCount: posts.length, filteredCount: 0 };
    }
    minT = win.start;
    maxT = win.end;

    const NICE = [
      [60,         "1 min"],
      [300,        "5 min"],
      [900,        "15 min"],
      [1800,       "30 min"],
      [3600,       "1 hour"],
      [7200,       "2 hours"],
      [21600,      "6 hours"],
      [43200,      "12 hours"],
      [86400,      "1 day"],
      [86400 * 2,  "2 days"],
      [86400 * 7,  "1 week"],
      [86400 * 14, "2 weeks"],
      [86400 * 30, "1 month"],
    ];
    const rangeS = Math.max(60, maxT - minT);
    const idealS = rangeS / targetBuckets;
    let bucketS = NICE[NICE.length - 1][0];
    let bucketLabel = NICE[NICE.length - 1][1];
    for (const [s, lbl] of NICE) {
      if (s >= idealS) { bucketS = s; bucketLabel = lbl; break; }
    }

    const buckets = new Map();
    const subTotals = {};
    for (const p of filteredPosts) {
      if (!p.created_utc) continue;
      const start = Math.floor(p.created_utc / bucketS) * bucketS;
      const sub = (p.subreddit || "").toLowerCase();
      if (!sub) continue;
      if (!buckets.has(start)) buckets.set(start, {});
      const b = buckets.get(start);
      b[sub] = (b[sub] || 0) + 1;
      subTotals[sub] = (subTotals[sub] || 0) + 1;
    }

    /* Pad out empty buckets so the chart's x-axis is uniformly spaced
     * (otherwise gaps in posting time would compress visually). */
    const startBucket = Math.floor(minT / bucketS) * bucketS;
    const endBucket = Math.floor(maxT / bucketS) * bucketS;
    const allKeys = [];
    for (let t = startBucket; t <= endBucket; t += bucketS) allKeys.push(t);

    const subs = Object.keys(subTotals).sort((a, b) => subTotals[b] - subTotals[a]);
    const bySub = {};
    for (const sub of subs) {
      bySub[sub] = allKeys.map((t) => (buckets.get(t) || {})[sub] || 0);
    }
    const total = allKeys.map((t) => {
      const b = buckets.get(t);
      if (!b) return 0;
      let n = 0;
      for (const k in b) n += b[k];
      return n;
    });
    const keys = allKeys.map((t) => formatBucketLabel(new Date(t * 1000), bucketS));

    /* Human-readable window length for the chart subtitle. */
    const winSpan = maxT - minT;
    let windowLabel;
    if (winSpan < 86400) windowLabel = Math.max(1, Math.round(winSpan / 3600)) + "h";
    else if (winSpan < 86400 * 30) windowLabel = Math.max(1, Math.round(winSpan / 86400)) + "d";
    else if (winSpan < 86400 * 365) windowLabel = Math.max(1, Math.round(winSpan / (86400 * 30))) + "mo";
    else windowLabel = (winSpan / (86400 * 365)).toFixed(1) + "y";

    return {
      keys, total, bySub, subs, bucketS, bucketLabel, windowLabel,
      filteredCount: filteredPosts.length,
      droppedCount: posts.length - filteredPosts.length,
    };
  };

  function formatBucketLabel(d, bucketS) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    if (bucketS < 3600) return mm + "-" + dd + " " + hh + ":" + mi;
    if (bucketS < 86400) return mm + "-" + dd + " " + hh + ":00";
    if (bucketS < 86400 * 7) return mm + "-" + dd;
    return yyyy + "-" + mm + "-" + dd;
  }

  Analysis.bucketByHour = function (posts) {
    /* Bucket at LOCAL hour boundaries so a post made at "10pm local"
     * shares a bucket with other 10pm-local posts regardless of where
     * the dashboard user is. The key is "YYYY-MM-DD HH:00" and is
     * lexicographically sortable. */
    const map = new Map();
    for (const p of posts) {
      if (!p.created_utc) continue;
      const d = new Date(p.created_utc * 1000);
      d.setMinutes(0, 0, 0);
      d.setSeconds(0);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const k = yyyy + "-" + mm + "-" + dd + " " + hh + ":00";
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
    const max = Math.max(...scores), min = Math.min(...scores);
    const span = Math.max(1, max - min);
    const step = span / bins;
    const labels = [];
    const counts = new Array(bins).fill(0);
    for (let i = 0; i < bins; i++) {
      const lo = min + i * step, hi = lo + step;
      labels.push(`${Util.fmtNum(lo)}–${Util.fmtNum(hi)}`);
    }
    for (const s of scores) {
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((s - min) / step)));
      counts[idx]++;
    }
    return { labels, counts };
  };

  /* ============================================================
     Constants exposed for the UI layer
     ============================================================ */
  Analysis.DAY_NAMES = DAY_NAMES;

  /* The substring-based candidate scorer that used to live here — a
   * civic/off-topic lexicon, Analysis.scoreCandidate, discoverCandidates
   * and the query builders — has moved to js/discovery.js, which scores
   * the same candidates by term-vector cosine instead of counting
   * keyword substrings inside descriptions. */

  /* ============================================================
     COMMENT-SIDE ANALYSIS (PR 4)
     ----------------------------------------------------------------
     Inputs are Reddit comment objects shaped like
       { id, author, body, score, created_utc, replies: <int> }
     (see Reddit.fetchPostWithComments). Outputs:
       - threadTemperature(comments) -> 'hostile'|'mixed'|'supportive'|'flat'
       - extractObjections(comments, opts) -> top negative phrases
       - detectBrigading(comments) -> heuristic suspicion score + reasons
       - commentVelocity(comments, postCreatedUtc) -> per-hour velocity
     ============================================================ */

  Analysis.threadTemperature = function (comments) {
    if (!comments || !comments.length) return { label: "flat", score: 0, support: 0, oppose: 0, neutral: 0, total: 0 };
    let support = 0, oppose = 0, neutral = 0;
    let weightedScore = 0, totalWeight = 0;
    for (const c of comments) {
      const txt = String(c.body || "").slice(0, 600);
      if (!txt) continue;
      const s = Analysis.scoreSentiment(txt);
      /* Weight by sqrt(score+1) so heavily-upvoted comments matter
       * more — they're the visible top of the thread. */
      const w = Math.sqrt(Math.max(0, (c.score || 0)) + 1);
      weightedScore += s.score * w;
      totalWeight += w;
      if (s.score > 0.15) support++;
      else if (s.score < -0.15) oppose++;
      else neutral++;
    }
    const avg = totalWeight ? weightedScore / totalWeight : 0;
    let label;
    if (avg >= 0.25) label = "supportive";
    else if (avg <= -0.25) label = "hostile";
    else if (Math.abs(avg) < 0.05 && neutral > support + oppose) label = "flat";
    else label = "mixed";
    return { label, score: avg, support, oppose, neutral, total: comments.length };
  };

  /* Pull recurring negative phrases (top objections) by extracting
   * 2- and 3-grams from comments scored as negative, then ranking
   * by frequency × negative-magnitude. */
  Analysis.extractObjections = function (comments, opts) {
    opts = opts || {};
    const limit = opts.limit || 5;
    const STOP = new Set(["the","a","an","and","or","but","that","this","is","are","was","were","be","been","to","of","in","on","at","for","with","by","from","it","its","as","not","no","do","does","did","will","would","should","can","could","may","might","should","i","you","he","she","we","they","me","my","your","our","their","his","her","them","us","just","like","really","very","much","more","most","some","any","all","any","every"]);
    const counts = new Map();
    for (const c of comments) {
      const txt = String(c.body || "");
      if (!txt) continue;
      const sent = Analysis.scoreSentiment(txt);
      if (sent.score >= -0.05) continue;
      const tokens = txt.toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, " ")
        .trim()
        .split(/\s+/)
        .filter((t) => t && t.length >= 3 && !STOP.has(t));
      const negWeight = Math.min(3, -sent.score * 4);
      for (let i = 0; i < tokens.length - 1; i++) {
        const bg = tokens[i] + " " + tokens[i + 1];
        counts.set(bg, (counts.get(bg) || 0) + negWeight);
      }
      for (let i = 0; i < tokens.length - 2; i++) {
        const tg = tokens[i] + " " + tokens[i + 1] + " " + tokens[i + 2];
        counts.set(tg, (counts.get(tg) || 0) + negWeight * 1.2);
      }
    }
    const ranked = Array.from(counts.entries())
      .filter(([, w]) => w >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit * 3);
    /* Deduplicate: drop bigrams that are subsumed by a higher-ranked
     * trigram (e.g. drop "voter id" when "voter id laws" is higher). */
    const out = [];
    for (const [phrase, w] of ranked) {
      const dup = out.some(([p2]) => p2.includes(phrase) && p2.split(" ").length > phrase.split(" ").length);
      if (!dup) out.push([phrase, w]);
      if (out.length >= limit) break;
    }
    return out.map(([phrase, weight]) => ({ phrase, weight: Math.round(weight) }));
  };

  /* Heuristic brigading detector. Returns {score 0-100, reasons[]}.
   *
   * Signals (each contributes weight to the suspicion score):
   *   1. NEW_ACCOUNT_BURST  : >= 3 comments by accounts with all-numeric
   *      / very short usernames within a 5-minute window
   *   2. UNIFORM_NEGATIVITY : >= 60% of comments score negative AND
   *      median comment score is <= 0
   *   3. ZERO_KARMA_CLUSTER : >= 4 comments with score <= 0 from
   *      different authors that all match other signals
   *   4. RAPID_FIRE         : burst of >= 5 comments within 60s of each other
   *   5. AUTHOR_REPEATS     : same author posting many top-level comments
   *      (signals coordination from one user OR sock puppet)
   *
   * Without raw karma history (Reddit's API doesn't surface comment-author
   * karma in a thread fetch) we can only infer; score is a heuristic
   * "worth investigating" signal, not a verdict. */
  Analysis.detectBrigading = function (comments) {
    const reasons = [];
    let score = 0;
    if (!comments || comments.length < 5) return { score: 0, reasons: [], comments: comments && comments.length || 0 };

    /* 1. burst window - sort by created_utc, find 5-min windows */
    const sorted = comments.slice().sort((a, b) => (a.created_utc || 0) - (b.created_utc || 0));
    let maxBurst = 0;
    for (let i = 0; i < sorted.length; i++) {
      let j = i;
      while (j < sorted.length && (sorted[j].created_utc - sorted[i].created_utc) <= 300) j++;
      maxBurst = Math.max(maxBurst, j - i);
    }
    if (maxBurst >= 5) {
      score += 25;
      reasons.push(`${maxBurst} comments arrived within a 5-minute burst — possible coordinated push`);
    }

    /* 2. uniform negativity */
    let neg = 0, scores = [];
    for (const c of sorted) {
      const s = Analysis.scoreSentiment(String(c.body || "")).score;
      if (s < -0.1) neg++;
      scores.push(c.score || 0);
    }
    const negRatio = neg / sorted.length;
    scores.sort((a, b) => a - b);
    const medianScore = scores[Math.floor(scores.length / 2)];
    if (negRatio >= 0.6 && medianScore <= 0) {
      score += 30;
      reasons.push(`${Math.round(negRatio * 100)}% of comments are negative; median comment score is ${medianScore} — engagement is dominated by detractors`);
    }

    /* 3. zero-or-negative karma cluster */
    const zeroCluster = sorted.filter((c) => (c.score || 0) <= 0).length;
    if (zeroCluster >= 4 && zeroCluster / sorted.length >= 0.4) {
      score += 15;
      reasons.push(`${zeroCluster} comments at zero or negative karma — broader sub may not be backing them`);
    }

    /* 4. author repeats (same name posting many top-level) */
    const authorCounts = new Map();
    for (const c of sorted) {
      const a = (c.author || "").toLowerCase();
      if (!a || a === "[deleted]" || a === "automoderator") continue;
      authorCounts.set(a, (authorCounts.get(a) || 0) + 1);
    }
    const repeatAuthors = Array.from(authorCounts.entries()).filter(([, n]) => n >= 3);
    if (repeatAuthors.length >= 2) {
      score += 20;
      const names = repeatAuthors.slice(0, 3).map(([a, n]) => `u/${a} (${n})`).join(", ");
      reasons.push(`${repeatAuthors.length} authors posting 3+ top-level comments each (${names}) — possible sock-puppeting`);
    }

    /* 5. suspicious-username pattern (all-numeric / very short / random
     * suffixes typical of throwaway accounts) */
    const SUSPICIOUS = /^([a-z]{1,4}\d{4,}|\d{4,}|[a-z]{2,5}_\d{2,})$/i;
    const sus = sorted.filter((c) => c.author && SUSPICIOUS.test(c.author)).length;
    if (sus >= 3) {
      score += 10;
      reasons.push(`${sus} commenters have throwaway-style usernames (e.g. all-numeric / short letters + digits)`);
    }

    score = Math.min(100, score);
    return { score, reasons, comments: sorted.length };
  };

  /* Comments per hour over the post's lifespan. Tells you whether a
   * thread is alive (still pulling comments now) or dead. */
  Analysis.commentVelocity = function (comments, postCreatedUtc) {
    if (!comments || !comments.length) return { perHour: 0, ageHours: 0, total: 0, alive: false };
    const now = Math.floor(Date.now() / 1000);
    const ageHours = postCreatedUtc ? Math.max(0.05, (now - postCreatedUtc) / 3600) : 1;
    const perHour = comments.length / ageHours;
    /* Compare last-hour rate vs lifetime rate to spot live threads. */
    const lastHourCutoff = now - 3600;
    const lastHour = comments.filter((c) => (c.created_utc || 0) >= lastHourCutoff).length;
    const alive = lastHour >= Math.max(2, perHour * 0.5);
    return { perHour: Math.round(perHour * 100) / 100, ageHours, total: comments.length, lastHour, alive };
  };

  /* Recurring topical words from a comment thread, weighted by comment
   * score so the visible top of the thread shapes the vocabulary. This
   * is the audience-side counterpart to extractKeywords on post text —
   * same stoplist, different input, kept separate so destination match
   * (title/body) and reception (what people actually talked about) do
   * not collapse into one number. */
  Analysis.extractCommentKeywords = function (comments, limit) {
    const counts = {};
    if (!comments || !comments.length) return [];
    for (const c of comments) {
      const txt = String(c.body || "").slice(0, 800);
      if (!txt) continue;
      const w = Math.sqrt(Math.max(0, (c.score || 0)) + 1);
      for (const t of tokenize(txt)) {
        if (isWeak(t)) continue;
        counts[t] = (counts[t] || 0) + w;
      }
    }
    return Object.entries(counts)
      .map(([word, weight]) => ({ word, weight: Math.round(weight * 10) / 10 }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit || 8);
  };

  /* One object the UI can hang on a post: thread tone + audience
   * vocabulary + a couple of objections. Callers cache this per post id
   * so Recommend / Feed can show reception without re-scoring. */
  Analysis.summarizeAudience = function (comments) {
    const empty = {
      label: "flat",
      score: 0,
      support: 0,
      oppose: 0,
      neutral: 0,
      total: 0,
      keywords: [],
      objections: [],
      at: Date.now(),
    };
    if (!comments || !comments.length) return empty;
    const temp = Analysis.threadTemperature(comments);
    return {
      label: temp.label,
      score: temp.score,
      support: temp.support,
      oppose: temp.oppose,
      neutral: temp.neutral,
      total: temp.total || comments.length,
      keywords: Analysis.extractCommentKeywords(comments, 8),
      objections: Analysis.extractObjections
        ? Analysis.extractObjections(comments, { limit: 3 })
        : [],
      at: Date.now(),
    };
  };

  /* ============================================================
     PREDICTIVE POSTING (PR 5)
     ----------------------------------------------------------------
     Tiny on-device model that predicts the score of a HYPOTHETICAL
     post in a sub at a specific hour, using the sub's loaded posts
     as training data.

     Approach: per-sub, per-hour median + IQR with a small bonus for
     title-quality fit. We deliberately AVOID a real linear regression
     here — it would overfit small per-sub samples and the median is
     more robust to the long-tail breakouts that dominate Reddit.

     Returns { sub, hour, dayOfWeek, expectedLow, expectedMid,
               expectedHigh, sample, hourSample, confidence,
               recommendedTitleAdjustments }.
     ============================================================ */

  Analysis.predictPostScore = function (sub, draft, opts) {
    opts = opts || {};
    const allPosts = opts.posts || [];
    /* Filter to this sub */
    const subPosts = allPosts.filter((p) =>
      String(p.subreddit || "").toLowerCase() === String(sub || "").toLowerCase()
      && !p.stickied && !p.removed
    );
    if (subPosts.length < 5) {
      return {
        sub, expectedLow: null, expectedMid: null, expectedHigh: null,
        sample: subPosts.length, hourSample: 0, confidence: "low",
        message: "Need at least 5 loaded posts for r/" + sub + " to predict.",
      };
    }
    const hour = opts.hour != null ? opts.hour : new Date().getHours();
    const dayOfWeek = opts.dayOfWeek != null ? opts.dayOfWeek : new Date().getDay();

    /* Posts at this hour-of-day (any day) */
    const hourPosts = subPosts.filter((p) => {
      const t = (p.created_utc || 0) * 1000;
      return new Date(t).getHours() === hour;
    });

    /* Distribution: prefer the hour-specific subset when sample >= 4,
     * else fall back to the whole-sub distribution (lower confidence). */
    const useHourSubset = hourPosts.length >= 4;
    const dist = (useHourSubset ? hourPosts : subPosts).map((p) => p.score || 0).slice().sort((a, b) => a - b);
    function pct(arr, p) {
      if (!arr.length) return 0;
      return arr[Math.max(0, Math.min(arr.length - 1, Math.floor((arr.length - 1) * p / 100)))];
    }
    let p25 = pct(dist, 25), p50 = pct(dist, 50), p75 = pct(dist, 75);

    /* Title-quality fit. If the user provided a draft title, score it
     * against the sub's existing title-quality distribution. Posts in
     * the top quartile of title quality typically score 1.3-2x median;
     * bottom quartile drops 0.5-0.7x. */
    let titleMultiplier = 1;
    let recommendations = [];
    if (draft && typeof draft === "string" && draft.trim()) {
      const tq = Analysis.titleQuality ? Analysis.titleQuality(draft) : null;
      if (tq) {
        const subTQs = subPosts.map((p) => Analysis.titleQuality(p.title || "").score).sort((a, b) => a - b);
        const draftPercentile = subTQs.length ? subTQs.findIndex((s) => s >= tq.score) / subTQs.length : 0.5;
        /* Simple multiplier curve: percentile 0.0 -> 0.65, 0.5 -> 1.0,
         * 1.0 -> 1.6. */
        titleMultiplier = 0.65 + draftPercentile * 0.95;
        if (tq.factors) {
          for (const f of tq.factors) {
            if (!f.ok && f.delta < 0) {
              recommendations.push({ label: f.label, delta: f.delta });
            }
          }
        }
        recommendations.sort((a, b) => a.delta - b.delta);
      }
    }
    p25 = Math.round(p25 * titleMultiplier);
    p50 = Math.round(p50 * titleMultiplier);
    p75 = Math.round(p75 * titleMultiplier);

    let confidence;
    if (useHourSubset && hourPosts.length >= 10) confidence = "high";
    else if (subPosts.length >= 30 || hourPosts.length >= 6) confidence = "medium";
    else confidence = "low";

    return {
      sub, hour, dayOfWeek,
      expectedLow:  p25,
      expectedMid:  p50,
      expectedHigh: p75,
      sample: subPosts.length,
      hourSample: hourPosts.length,
      confidence,
      titleMultiplier: Math.round(titleMultiplier * 100) / 100,
      recommendedTitleAdjustments: recommendations.slice(0, 3),
    };
  };

  /* ============================================================
     CASCADE SCHEDULER
     ----------------------------------------------------------------
     Given a list of target subs, lay out a staggered posting order so
     each one catches its own best time without two posts landing on
     top of each other.

     The first version of this did something that looked right and was
     not. It read each sub's peak, sorted the list by clock time, and
     then walked the list pushing anything within an hour of the
     previous entry forward by an hour. With a handful of subs that is
     a nudge. With a hundred it is a traffic jam: each push creates the
     next collision, so the whole tail marches forward in lockstep and
     the times stop being peaks at all. Measured over 101 communities
     with known peaks, five landed on their own best hour, the mean
     miss was 5.8 hours, and the worst was 12 — the furthest it is
     possible to be from a time of day. The plan also quietly ran to
     100 hours, because a hundred subs an hour apart is four days.

     Two more things were wrong underneath that. The score printed on
     a row was computed at the sub's peak, not at the time the row
     actually told you to post, so a stop displaced six hours could
     advertise nine times the score it would really get. And the peak
     itself came from the raw arg-max of average score by hour, the
     estimator js/timing.js exists to replace — one lucky post at 3am
     is enough to name 3am the best hour.

     So this now:

       1. Asks js/timing.js for the peak, and evaluates its fitted
          curve to score any other time, rather than re-deriving a
          worse answer locally.
       2. Hands out slots strongest-opportunity-first, so a community
          worth two thousand points is not displaced by one worth two
          that happened to sort earlier.
       3. Prices every displacement against that curve, and reports
          what the plan is costing where it could not give a sub its
          own peak.
       4. Stops at a horizon instead of running for days.

     Returns rows ordered chronologically, each carrying both the time
     it recommends and the sub's own peak, so a row that is not on peak
     can say so instead of implying it is.
     ============================================================ */

  const SLOT_MIN = 15;
  const SLOTS_PER_DAY = 96;
  const DAY_MIN = 1440;

  /* Everything the scheduler needs to know about one community: when
     it is best, how good that is, and how good anything else is. */
  function cascadeCandidate(sub, posts, profile, now) {
    const key = String(sub).toLowerCase();
    const mine = posts.filter((p) => p && String(p.subreddit || "").toLowerCase() === key);

    let row = null;
    if (window.Timing && Timing.row && mine.length) {
      try { row = Timing.row(key, sub, mine, { now: now.getTime() }); } catch (_) { row = null; }
    }

    const fit = row && row.fit;
    const curve = fit && fit.curveScores && fit.curveScores.length === SLOTS_PER_DAY
      ? fit.curveScores : null;

    /* Everything here is minutes of day, 0..1439, because that is what
       Timing speaks: `fit.slot` is already minutes (bestIdx * 15), not
       an index into the 96-slot grid. Treating it as an index once put
       peaks thirteen days out and emptied most of the plan, so the
       unit is now the same everywhere and named for what it is.

       Preference order for "when": the fitted quarter-hour, then the
       fitted hour, then the naive profile peak as a last resort —
       flagged, because it is the weakest of the three. */
    let peakMinute = null, modelled = false;
    if (fit && fit.slot != null && fit.slot >= 0) { peakMinute = fit.slot; modelled = true; }
    else if (row && row.bestHour >= 0) { peakMinute = row.bestHour * 60; modelled = true; }
    else if (profile && profile.bestHour >= 0) { peakMinute = profile.bestHour * 60; }
    if (peakMinute == null || !isFinite(peakMinute)) return null;
    peakMinute = ((Math.round(peakMinute) % DAY_MIN) + DAY_MIN) % DAY_MIN;

    const scoreAt = (minuteOfDay) => {
      const m = ((Math.round(minuteOfDay) % DAY_MIN) + DAY_MIN) % DAY_MIN;
      if (curve) return Math.max(0, curve[Math.floor(m / SLOT_MIN) % SLOTS_PER_DAY]);
      /* No fitted curve: fall back to the old per-hour estimate, which
         at least varies with the hour asked about. */
      const pred = Analysis.predictPostScore(sub, null, { posts: posts, hour: Math.floor(m / 60) });
      return (pred && pred.expectedMid) || (profile && profile.medianScore) || 0;
    };

    return {
      sub: sub,
      key: key,
      peakMinute: peakMinute,
      peakScore: scoreAt(peakMinute),
      scoreAt: scoreAt,
      modelled: modelled,
      /* Whether the recommended window is open at this moment, and how
         wide it is either side of the peak. A stop inside its window is
         on time even when the single best quarter-hour has passed. */
      openNow: !!(row && row.next && row.next.open),
      windowRadius: row && row.window && row.window.minutes
        ? Math.round(row.window.minutes / 2) : 0,
      /* "strong" / "likely" / "weak" from the permutation test, which
         is a claim about evidence rather than about volume. */
      signal: (row && row.signal) || "none",
      confidence: row ? row.confidence : "insufficient",
      lift: row ? row.lift : 0,
      samples: mine.length,
    };
  }

  /* The next time this minute-of-day comes round, as minutes from now. */
  function minutesUntil(minuteOfDay, now) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    let d = minuteOfDay - nowMin;
    while (d <= 0) d += DAY_MIN;
    return d;
  }

  Analysis.cascadeSchedule = function (subs, opts) {
    opts = opts || {};
    const posts = opts.posts || [];
    const subProfiles = opts.subProfiles || {};
    const minGap = opts.minGapMinutes || 60;
    /* Two days. Long enough to give most communities a real peak,
       short enough that the plan is still a plan — the old one ran to
       four days without ever saying so. */
    const horizon = (opts.horizonHours || 48) * 60;
    const limit = opts.limit || 0;

    const now = opts.now ? new Date(opts.now) : new Date();
    const nowMinute = now.getHours() * 60 + now.getMinutes();
    /* Score any offset from now by where it lands on the 24-hour clock,
       rather than by how far it is from the peak. Same answer when the
       stop got its peak, and the right one when it did not. */
    const clockAt = (offset) => nowMinute + offset;

    const candidates = [];
    for (const sub of subs) {
      const key = String(sub).toLowerCase();
      const profile = subProfiles[key] || subProfiles[sub] || null;
      const c = cascadeCandidate(sub, posts, profile, now);
      if (c) candidates.push(c);
    }

    /* Best opportunity picks first. This is the whole difference
       between a schedule and a queue: the old one let clock order
       decide who got their peak, which is how a one-point community
       came to displace a two-thousand-point one. */
    candidates.sort((a, b) => b.peakScore - a.peakScore);

    const taken = [];
    const free = (t) => taken.every((u) => Math.abs(u - t) >= minGap);

    const placed = [];
    const dropped = [];
    for (const c of candidates) {
      if (limit && placed.length >= limit) { dropped.push({ sub: c.sub, why: "limit" }); continue; }

      /* If the community's recommended window is open right now, the
         next good moment is now — not this time tomorrow.
         
         Scheduling the next occurrence of the peak minute regardless
         made the two halves of the Plan hub contradict each other: the
         recommendation above said "post now, window open until 10:00"
         while the run below scheduled the same community for 07:15 the
         following morning, twenty-two hours later. */
      const want = c.openNow ? 5 : minutesUntil(c.peakMinute, now);
      let at = null;

      if (want <= horizon && free(want)) {
        at = want;
      } else {
        /* Search outward from the peak for the best time still open,
           rather than simply the next one. A community with a broad
           afternoon plateau should slide along the plateau; one with a
           single sharp spike should be told what missing it costs. */
        let bestAt = null, bestScore = -Infinity;
        const maxStep = Math.ceil(horizon / SLOT_MIN);
        for (let step = 1; step <= maxStep; step++) {
          for (const dir of [-1, 1]) {
            const t = want + dir * step * SLOT_MIN;
            if (t < 5 || t > horizon) continue;
            if (!free(t)) continue;
            const s = c.scoreAt(clockAt(t));
            if (s > bestScore) { bestScore = s; bestAt = t; }
          }
          /* Once something is found, finish the ring at this distance
             so the better of the two directions wins, then stop. */
          if (bestAt != null && step > 4) break;
        }
        at = bestAt;
      }

      if (at == null) { dropped.push({ sub: c.sub, why: "no room" }); continue; }

      taken.push(at);
      const expected = c.scoreAt(clockAt(at));
      /* Distance from the community's own peak, on the clock rather than
         the calendar: a peak a day out and the same peak today are the
         same time of day. */
      let driftMin = clockAt(at) - c.peakMinute;
      driftMin = ((driftMin % DAY_MIN) + DAY_MIN) % DAY_MIN;
      if (driftMin > DAY_MIN / 2) driftMin -= DAY_MIN;
      /* Inside its recommended window is on time, however far the single
         best quarter-hour happens to be — the window is the finding, and
         the peak is only its midpoint. */
      const inWindow = c.openNow && Math.abs(driftMin) <= (c.windowRadius || 0);

      placed.push({
        sub: c.sub,
        targetTime: new Date(now.getTime() + at * 60000),
        /* The peak nearest this stop, not the next occurrence of it. A
           stop can sit slightly after a peak whose window is still open,
           and "its peak is tomorrow morning" would be a strange thing to
           say about a row scheduled for the next five minutes. Derived
           from the drift so the two can never disagree. */
        peakTime: new Date(now.getTime() + (at - driftMin) * 60000),
        hourLocal: new Date(now.getTime() + at * 60000).getHours(),
        /* The number now describes the time on the same row. */
        predictedScore: expected,
        peakScore: c.peakScore,
        onPeak: inWindow || Math.abs(driftMin) < SLOT_MIN,
        openNow: !!c.openNow,
        driftMinutes: driftMin,
        /* What the stagger costs here, as a share of the peak. Zero
           when it got what it wanted. */
        cost: c.peakScore > 0 ? Math.max(0, 1 - expected / c.peakScore) : 0,
        signal: c.signal,
        modelled: c.modelled,
        samples: c.samples,
        confidence: c.signal === "strong" ? "high"
          : c.signal === "likely" ? "medium"
            : c.modelled ? "low" : "low",
      });
    }

    placed.sort((a, b) => a.targetTime - b.targetTime);
    let prev = null;
    for (const s of placed) {
      s.gapMinutes = prev ? Math.round((s.targetTime - prev) / 60000) : 0;
      prev = s.targetTime;
    }
    placed.dropped = dropped;
    return placed;
  };

  /* ============================================================
     TITLE REWRITER (PR 5)
     ----------------------------------------------------------------
     Heuristic-only — no remote AI. Given a draft title and an optional
     target audience ("activist" / "civic" / "urgency"), generate up
     to 3 rephrasing variants by swapping vocabulary and adjusting
     phrasing patterns.
     ============================================================ */

  const VOCAB_ACTIVIST = {
    "needed": "demand", "needs": "demands",
    "should": "must", "support": "back",
    "discuss": "organize", "talking": "organizing",
    "issue": "fight", "issues": "fights",
    "movement": "uprising",
    "action": "action now",
    "people": "workers",
    "vote": "mobilize",
    "speech": "rally cry",
  };
  const VOCAB_CIVIC = {
    "demand": "request", "demands": "requests",
    "must": "should", "fight": "discuss",
    "uprising": "movement",
    "rally": "town hall",
    "strike": "work stoppage",
  };
  const VOCAB_URGENCY = {
    "soon": "now", "today": "tonight",
    "may": "will", "might": "will",
    "consider": "act on",
    "discuss": "decide on",
    "discussion": "decision",
  };

  function applyVocab(text, vocab) {
    const re = new RegExp("\\b(" + Object.keys(vocab).map((k) => k.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")).join("|") + ")\\b", "gi");
    return text.replace(re, (m) => {
      const replacement = vocab[m.toLowerCase()];
      if (!replacement) return m;
      /* Preserve original case (Title Case stays Title Case). */
      if (m[0] === m[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
      return replacement;
    });
  }

  Analysis.rewriteTitle = function (draft, opts) {
    opts = opts || {};
    if (!draft || typeof draft !== "string") return [];
    const variants = [];
    const trimmed = draft.trim();

    /* 1. Activist vocabulary swap */
    const v1 = applyVocab(trimmed, VOCAB_ACTIVIST);
    if (v1 !== trimmed) variants.push({
      style: "activist",
      title: v1,
      hint: "Activist vocabulary — works in movement rooms; also try civic discussion and issue desks when the ask is broader",
    });

    /* 2. Civic / institutional vocabulary swap */
    const v2 = applyVocab(trimmed, VOCAB_CIVIC);
    if (v2 !== trimmed && v2 !== v1) variants.push({
      style: "civic",
      title: v2,
      hint: "Neutral-civic tone — works well in r/politics, r/voting, r/AskReddit",
    });

    /* 3. Urgency rephrase + lead-with-verb */
    let v3 = applyVocab(trimmed, VOCAB_URGENCY);
    /* Prefix-style: "How about X" / "Should we X" -> imperative. */
    v3 = v3.replace(/^\s*(?:how about|should we|can we|maybe we should)\s+/i, "");
    if (!/^[A-Z][a-z]+ /.test(v3)) {
      /* If not already starting with a verb, leave it; light heuristic. */
    }
    /* Append "— now" if it doesn't end with a clear verb-now pattern. */
    if (v3 !== trimmed && !/\bnow\b/i.test(v3)) v3 = v3.replace(/[.!]+$/, "") + " — now";
    if (v3 !== trimmed && v3 !== v1 && v3 !== v2) variants.push({
      style: "urgency",
      title: v3,
      hint: "Urgent / call-to-action tone — works well during launch days",
    });

    /* 4. Question -> declarative if present */
    if (/\?\s*$/.test(trimmed)) {
      const v4 = trimmed.replace(/\?\s*$/, ".");
      variants.push({
        style: "declarative",
        title: v4,
        hint: "Declarative reframe — comes across as more confident",
      });
    }
    return variants.slice(0, 3);
  };

  /* ============================================================
     CAMPAIGN A/B COMPARISON (PR 6)
     ----------------------------------------------------------------
     Compares two campaigns side by side using their resolved-post
     summaries. Returns a structured payload the UI can render in
     two columns + insight bullets at the top.
     ============================================================ */

  Analysis.compareCampaigns = function (a, b) {
    if (!a || !b) return null;
    function summarize(c) {
      const posts = (c.posts || []).filter((p) => !p.stickied && !p.removed);
      const totalScore = posts.reduce((x, p) => x + (p.score || 0), 0);
      const totalComments = posts.reduce((x, p) => x + (p.num_comments || 0), 0);
      const subs = new Set(posts.map((p) => (p.subreddit || "").toLowerCase()));
      const sentiment = Analysis.aggregateSentiment(posts);
      const themes = Analysis.themes(posts, { uniTop: 6, biTop: 4, minPosts: 2 });
      const avgScore = posts.length ? totalScore / posts.length : 0;
      return { posts, totalScore, totalComments, subCount: subs.size, subs, sentiment, themes, avgScore, campaignName: c.name };
    }
    const A = summarize(a);
    const B = summarize(b);
    function pctDelta(x, y) {
      if (!y && !x) return 0;
      if (!y) return 100;
      return Math.round((x - y) / y * 100);
    }
    /* Theme overlap */
    const aTerms = new Set((A.themes || []).map((t) => t.term.toLowerCase()));
    const bTerms = new Set((B.themes || []).map((t) => t.term.toLowerCase()));
    const intersect = Array.from(aTerms).filter((t) => bTerms.has(t));
    const aOnly = Array.from(aTerms).filter((t) => !bTerms.has(t));
    const bOnly = Array.from(bTerms).filter((t) => !aTerms.has(t));
    /* Sub overlap */
    const subIntersect = Array.from(A.subs).filter((s) => B.subs.has(s));
    /* Insights — natural-language bullets */
    const insights = [];
    if (A.posts.length && B.posts.length) {
      const dScore = pctDelta(A.totalScore, B.totalScore);
      if (Math.abs(dScore) >= 15) {
        insights.push(`<strong>${Util.escapeHtml(A.campaignName)}</strong> drove ${Math.abs(dScore)}% ${dScore > 0 ? "more" : "fewer"} total upvotes than <strong>${Util.escapeHtml(B.campaignName)}</strong>`);
      }
      const dAvg = pctDelta(A.avgScore, B.avgScore);
      if (Math.abs(dAvg) >= 25) {
        insights.push(`Per-post average is ${Math.abs(dAvg)}% ${dAvg > 0 ? "higher" : "lower"} for <strong>${Util.escapeHtml(A.campaignName)}</strong> — ${dAvg > 0 ? "smaller drops" : "needs more reach"}`);
      }
      const dSubs = A.subCount - B.subCount;
      if (dSubs !== 0) {
        insights.push(`<strong>${Util.escapeHtml(A.campaignName)}</strong> hit ${A.subCount} subs vs ${B.subCount} for <strong>${Util.escapeHtml(B.campaignName)}</strong>${dSubs > 0 ? " — wider spread" : " — more concentrated"}`);
      }
      if (intersect.length) {
        insights.push(`Shared themes: ${intersect.slice(0, 4).map((t) => `"${Util.escapeHtml(t)}"`).join(", ")}`);
      }
      if (subIntersect.length) {
        insights.push(`Both ran in ${subIntersect.length} of the same subs (${subIntersect.slice(0, 3).map((s) => "r/" + s).join(", ")}${subIntersect.length > 3 ? ", …" : ""})`);
      }
    }
    return {
      A: { name: a.name, ...A },
      B: { name: b.name, ...B },
      themes: { intersect, aOnly, bOnly },
      subIntersect,
      insights,
    };
  };

  window.Analysis = Analysis;
})();
