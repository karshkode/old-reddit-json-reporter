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

  function tokenize(text) {
    return ((text || "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [])
      .filter((t) => !STOPWORDS.has(t) && t.length >= 3 && t.length <= 28);
  }

  Analysis.extractKeywords = function (posts, limit) {
    const counts = {};
    for (const p of posts) {
      const toks = tokenize((p.title || "") + " " + (p.flair || ""));
      for (const t of toks) counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit || 30);
  };

  Analysis.extractBigrams = function (posts, limit) {
    const counts = {};
    for (const p of posts) {
      const toks = tokenize(p.title || "");
      for (let i = 0; i < toks.length - 1; i++) {
        const a = toks[i], b = toks[i + 1];
        if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
        const k = a + " " + b;
        counts[k] = (counts[k] || 0) + 1;
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

    const out = [];
    for (const seed of seeds) {
      const re = seed.kind === "phrase"
        ? new RegExp("\\b" + escapeRe(seed.term) + "\\b", "i")
        : new RegExp("\\b" + escapeRe(seed.term) + "\\b", "i");
      const matches = posts.filter((p) => re.test((p.title || "") + " " + (p.flair || "")));
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
      totalViews, viewsKnown,
      avgScore: Util.average(scores),
      medianScore: Util.median(scores),
      p95Score: Util.percentile(scores, 95),
      avgComments: Util.average(comments),
      avgUpvoteRatio: ratios.length ? Util.average(ratios) : null,
      topPost, lowPost,
      bySubreddit, byHour, byDow, avgScoreByHour,
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
      byHour: agg.byHour,
      byDow: agg.byDow,
      avgScoreByHour: agg.avgScoreByHour,
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
      const fp = titleFingerprint(p.title) ||
                 (p.title || "").toLowerCase().replace(/\s+/g, " ").trim();
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
     12. RECOMMENDATIONS  &  NARRATIVE
     ============================================================ */

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
    out.push(`Posts published around <strong>${pad2(bestHour)}:00 ${Util.escapeHtml(Util.getTzLabel())}</strong> show the highest average score (${Util.fmtNum(bestVal)} avg). <span class="meta">All times in your local timezone.</span>`);

    let bestDow = 0, bestDowVal = -1;
    for (let d = 0; d < 7; d++) {
      if (agg.byDow[d] > bestDowVal) { bestDowVal = agg.byDow[d]; bestDow = d; }
    }
    out.push(`<strong>${DAY_NAMES[bestDow]}</strong> is the most active submission day (${bestDowVal} posts).`);

    if (agg.avgUpvoteRatio != null) {
      const r = agg.avgUpvoteRatio;
      if (r >= 0.9) out.push(`Audience reception is <strong>strongly positive</strong> — upvote ratio ${Util.fmtPct(r)}.`);
      else if (r >= 0.75) out.push(`Audience reception is <strong>healthy</strong> — upvote ratio ${Util.fmtPct(r)}.`);
      else if (r >= 0.6) out.push(`Audience reception is <strong>mixed</strong> — upvote ratio ${Util.fmtPct(r)}; consider tightening title framing.`);
      else out.push(`Audience reception looks <strong>contentious</strong> — upvote ratio ${Util.fmtPct(r)}. Posts may be drawing brigading or off-topic engagement.`);
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
    if (ratio >= 25) out.push(`Posts attract upvotes faster than comments (≈${ratio.toFixed(1)}× score-to-comment ratio) — content is shareable rather than discussion-driving.`);
    else if (ratio > 0 && ratio <= 5) out.push(`Posts spark above-average discussion (low score-to-comment ratio of ${ratio.toFixed(1)}) — strong engagement content.`);

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

  /* ============================================================
     13b. DISCOVERY LEXICONS
     ----------------------------------------------------------
     Words that pollute discovery (months, weekdays, generic verbs)
     get filtered before being used as search queries OR as evidence
     of theme match. CAMPAIGN_TERMS rewards subs whose descriptions
     genuinely use civic/activist/policy vocabulary; OFFTOPIC_TERMS
     penalises subs whose descriptions are dominated by celebrity,
     beauty, gaming, sports, fandom, or pure-story content.

     The lexicons are deliberately conservative — a single hit
     doesn't decide a sub's fate. Boost / penalty kicks in at
     >= 2 hits OR is combined with theme match.
     ============================================================ */

  const NON_TOPICAL_DISCOVERY_WORDS = new Set([
    /* time / date */
    "january","february","march","april","may","june","july","august",
    "september","october","november","december",
    "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
    "year","years","yearly","week","weeks","weekly","month","months","monthly",
    "day","days","daily","today","tomorrow","yesterday","tonight","morning",
    "evening","night","afternoon","weekend",
    /* questions / answers */
    "answer","answers","answered","ask","asks","asked","asking",
    "question","questions","wonder","wondering","wondered","tried","trying","try",
    /* generic placeholders */
    "thing","things","way","ways","place","places","stuff","group","groups",
    "person","persons","time","times","point","points","case","cases",
    "lot","lots","kind","kinds","sort","sorts","example","examples","part",
    /* speech verbs */
    "said","says","told","tells","talk","talked","talking","talks",
  ]);

  const CAMPAIGN_TERMS = new Set([
    /* ideology */
    "progressive","progressives","progress","left","leftist","leftwing",
    "liberal","liberals","democrat","democrats","democratic","democracy",
    "socialist","socialists","socialism","socdem","communist","communism",
    "anarchist","anarchism","anarcho","abolitionist","abolish","abolitionism",
    "antifascist","antifascism","antifa","anticapitalist",
    /* movement / civic action */
    "movement","movements","activism","activist","activists","organize",
    "organizing","organized","organizer","organizers","mobilize","mobilizing",
    "mobilization","grassroots","resist","resistance","occupy","demonstrate",
    "demonstration","demonstrations","demonstrator","demonstrators",
    "march","marches","marching","protest","protests","protested","protester",
    "protesters","rally","rallies","strike","strikes","striking","picket",
    "picketing","picketed","boycott","boycotts","boycotting","boycotted",
    "campaign","campaigns","campaigner","petition","petitions",
    /* civic / electoral */
    "vote","votes","voter","voters","voting","voted","ballot","ballots",
    "election","elections","electoral","registration","civic","civics",
    "constitutional","amendment","constituency","representative","senator",
    "congress","congressional","parliament","parliamentary",
    /* labor */
    "labor","labour","union","unions","unionize","unionizing","unionized",
    "worker","workers","working","employment","unemployment","wage","wages",
    "minimum","livable","tenant","tenants","rent","renter","renters",
    /* identity / justice */
    "feminist","feminism","queer","lgbt","lgbtq","lgbtqia","transgender",
    "intersectional","intersectionality","racial","racism","antiracist",
    "antiracism","sexism","misogyny","homophobia","transphobia",
    "marginalized","marginalised","oppress","oppressed","oppression",
    "systemic","disenfranchised","disenfranchisement","accountability",
    /* policy areas */
    "healthcare","medicare","medicaid","welfare","housing","homelessness",
    "climate","environmental","environment","ecology","green","ecosocialism",
    "education","immigration","refugees","reproductive","abortion",
    "policy","policies","reform","reforms","rights","justice","equity",
    "equal","equality","inequality","injustice","corruption","corrupt",
    /* anti */
    "antiwar","anti-war","antimonopoly","antimperialist","anti-imperialist",
    "dismantle","decolonize","decolonise",
  ]);

  const OFFTOPIC_TERMS = new Set([
    /* celebrity / TV / film */
    "celebrity","celebrities","celeb","celebs","star","stars","fame","famous",
    "show","shows","airs","season","seasons","episode","episodes","series",
    "drama","dramas","sitcom","reality","fanfic","fanfiction","fandom",
    "cosplay","comic","comics","manga","anime","kpop","kdrama","webtoon",
    "film","films","movie","movies","actor","actors","actress","hollywood",
    "soap","soaps","wetv","tlc","mtv","disney",
    /* beauty / fashion */
    "nail","nails","manicure","pedicure","makeup","beauty","fashion",
    "skincare","haircare","outfit","outfits","ootd","lipstick","perfume",
    "mascara","eyeshadow","contour","glam","cosmetic","cosmetics",
    /* gaming */
    "gaming","gamer","gamers","videogame","videogames","console","playstation",
    "xbox","nintendo","steam","mmo","fps","rpg","mmorpg","minecraft","fortnite",
    "roblox","valorant","csgo","dota","warcraft","wow","esport","esports",
    "twitch","streamer","speedrun",
    /* sports */
    "nfl","nba","mlb","nhl","fifa","soccer","football","basketball","baseball",
    "hockey","tennis","golf","cricket","rugby","mma","ufc","boxing","wrestling",
    /* hobbies / lifestyle / pets */
    "recipe","recipes","cooking","baking","fitness","workout","gym","yoga",
    "aquarium","gardening","manga","crochet","knitting","origami",
    /* story / update aggregators */
    "stories","story","update","updates","ouija","redditupdates",
    "redditorupdates","talkstoryupdates","gossip","tea","spill",
  ]);

  function lexiconHits(text, lex) {
    if (!text) return 0;
    const tokens = String(text).toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
    let n = 0;
    for (const t of tokens) if (lex.has(t)) n++;
    return n;
  }

  /* Used by the discovery layer; expose for unit tests / UI. */
  Analysis.NON_TOPICAL_DISCOVERY_WORDS = NON_TOPICAL_DISCOVERY_WORDS;
  Analysis.CAMPAIGN_TERMS = CAMPAIGN_TERMS;
  Analysis.OFFTOPIC_TERMS = OFFTOPIC_TERMS;

  /* ============================================================
     14. CANDIDATE DISCOVERY
     ------------------------------------------------------------
     Score brand-new subreddits (returned from /subreddits/search)
     against a campaign profile, using only the candidate's
     description, name and basic stats — no need to fetch its
     posts up-front. Posts can be loaded later for deeper scoring
     once the user adds the candidate to the dashboard.
     ============================================================ */

  Analysis.scoreCandidate = function (candidate, campaignProfile, opts) {
    if (!candidate || !campaignProfile) return null;
    const text = ((candidate.title || "") + " " +
                  (candidate.public_description || "") + " " +
                  (candidate.display_name || "")).toLowerCase();

    /* Filter campaign keywords/phrases used for *theme matching* to drop
     * generic noise (months, weekdays, "answer", "thing", "year", …) so
     * a sub doesn't get credit just because its description happens to
     * contain calendar words. The full keyword set is kept for the
     * separate keyword-cloud display elsewhere. */
    const isTopical = (w) => !NON_TOPICAL_DISCOVERY_WORDS.has(w);
    const phraseTopical = (p) => p.split(/\s+/).every(isTopical);

    const camKeys = (campaignProfile.keywords || [])
      .filter((k) => isTopical(k.word))
      .slice(0, 14).map((k) => k.word);
    const camPhrases = (campaignProfile.bigrams || [])
      .filter((b) => phraseTopical(b.phrase))
      .slice(0, 8).map((b) => b.phrase);

    let kwHits = 0, phHits = 0;
    const matchedKeys = [];
    const matchedPhrases = [];
    for (const k of camKeys) {
      if (text.indexOf(k) >= 0) { kwHits++; matchedKeys.push(k); }
    }
    for (const p of camPhrases) {
      if (text.indexOf(p) >= 0) { phHits++; matchedPhrases.push(p); }
    }
    const themeMatch = clamp01((kwHits / 6) + (phHits / 3) * 0.5);

    const subs = candidate.subscribers || 0;
    const popularity = clamp01(Math.log10(subs + 10) / 6);

    const ratio = subs > 0 ? (candidate.active_user_count || 0) / subs : 0;
    const engagement = clamp01(ratio * 1000);

    const safety = candidate.over18 ? 0 : 1;

    /* Bonus for subs that turned up in multiple search angles or were
     * surfaced from active-post mining — these are the ones the user
     * really hasn't seen yet, even if their description is sparse. */
    const queryHits = Math.max(0, Math.min(8, opts && opts.queryHits ? opts.queryHits : 0));
    const postHits = Math.max(0, Math.min(20, opts && opts.postHits ? opts.postHits : 0));
    const multiBoost = clamp01(queryHits / 4);
    const postBoost = clamp01(postHits / 8);

    /* Lexicon-based topical alignment. CAMPAIGN_TERMS rewards subs that
     * actually use civic/activist/policy vocabulary in their description;
     * OFFTOPIC_TERMS penalises subs dominated by celebrity / beauty /
     * gaming / fandom / pure-story content. Single hits are noise; the
     * boost / penalty needs >= 2 hits to dominate. */
    const sphereHits = lexiconHits(text, CAMPAIGN_TERMS);
    const offtopicHits = lexiconHits(text, OFFTOPIC_TERMS);
    const sphereBoost = clamp01(sphereHits / 3);     // 3 hits = full boost
    const offtopicPenalty = clamp01(offtopicHits / 2); // 2 hits = full penalty

    /* Catalog membership: known progressive-sphere subs from js/seeds.js
     * carry their own evidence even if their description happens to be
     * sparse on civic vocabulary. Tag-list comes from Seeds.spheresOf. */
    const catalogTags = (typeof window !== "undefined" && window.Seeds)
      ? window.Seeds.spheresOf(candidate.display_name || "")
      : [];
    const isCatalogMember = catalogTags.length > 0;
    const catalogBoost = isCatalogMember ? 0.20 : 0;

    /* Mega-sub guard: when a sub has millions of subscribers but weak
     * topical signal (no sphere hits, weak theme), don't let raw
     * popularity carry it. Keeps r/AskReddit / r/conspiracy from
     * dominating activist-campaign discovery. */
    const popularityEffective = (themeMatch < 0.20 && sphereHits === 0)
      ? popularity * 0.25
      : popularity;

    let raw =
      0.26 * themeMatch +
      0.08 * popularityEffective +
      0.10 * engagement +
      0.07 * multiBoost +
      0.09 * postBoost +
      0.04 * safety +
      0.22 * sphereBoost +
      catalogBoost;            /* +0.20 if a catalog member */
    raw -= 0.28 * offtopicPenalty;
    const composite = clamp01(raw);
    const score = Math.round(composite * 100);

    const reasons = [];
    if (matchedPhrases.length) reasons.push(`description matches <em>${matchedPhrases.map(htmlSafe).join(", ")}</em>`);
    if (matchedKeys.length) reasons.push(`description keyword overlap <em>${matchedKeys.slice(0, 6).map(htmlSafe).join(", ")}</em>`);
    if (!matchedPhrases.length && !matchedKeys.length && !postHits && !sphereHits) {
      reasons.push(`<span class="meta">no direct keyword match — ranked on size + activity only</span>`);
    }
    if (sphereHits >= 2) reasons.push(`<span class="badge good">progressive-sphere description</span> · ${sphereHits} aligned terms`);
    else if (sphereHits === 1) reasons.push(`<span class="meta">1 progressive-sphere term in description</span>`);
    if (offtopicHits >= 2) reasons.push(`<span class="badge bad">off-topic flags</span> · description leans entertainment / lifestyle (${offtopicHits} terms)`);
    if (postHits) reasons.push(`<span class="badge info">${postHits} hot post${postHits === 1 ? "" : "s"}</span> mention campaign keywords this month`);
    if (queryHits >= 2) reasons.push(`appeared in <strong>${queryHits}</strong> of your search angles`);
    if (isCatalogMember) reasons.unshift(`<span class="badge good">in catalog</span> · ${catalogTags.map((t) => Util.escapeHtml(t.replace("state:", "📍 ").replace("demo:", "👥 "))).join(" · ")}`);
    reasons.push(`<strong>${Util.fmtNum(subs)}</strong> subscribers`);
    if (candidate.active_user_count) {
      const pct = (ratio * 100).toFixed(2);
      reasons.push(`<strong>${Util.fmtNum(candidate.active_user_count)}</strong> active right now (${pct}% of subs)`);
    }
    return {
      score, composite,
      themeMatch, popularity, engagement,
      matchedKeys, matchedPhrases,
      queryHits, postHits,
      sphereHits, offtopicHits,
      catalogTags, isCatalogMember,
      reasons,
    };
  };

  /* opts:
   *   excludeNames  - subs to mark "alreadyLoaded" (still rendered separately)
   *   includeAlready - keep already-loaded ones tagged but in the result
   *   minSubs       - lower floor (default 25). Ghost-town protection only.
   *   limit         - top N "new" candidates to keep
   *   queryHitsByName - { lowercaseName: number of search angles it hit }
   *   postHitsByName  - { lowercaseName: number of hot posts that mentioned the campaign keywords }
   */
  Analysis.discoverCandidates = function (rawSearchResults, campaignProfile, opts) {
    opts = opts || {};
    const exclude = new Set(((opts.excludeNames || []).map((s) => String(s).toLowerCase())));
    const minSubs = opts.minSubs != null ? opts.minSubs : 25;
    const queryHitsByName = opts.queryHitsByName || {};
    const postHitsByName = opts.postHitsByName || {};
    const seen = new Set();
    const newOut = [];
    const alreadyOut = [];
    const strict = opts.strict !== false; /* default strict */
    let droppedOfftopic = 0, droppedWeak = 0, droppedMega = 0;
    for (const c of (rawSearchResults || [])) {
      if (!c || !c.display_name) continue;
      const name = String(c.display_name).toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      if (c.over18) continue;
      if ((c.subscribers || 0) < minSubs) continue;
      const scored = Analysis.scoreCandidate(c, campaignProfile, {
        queryHits: queryHitsByName[name] || 0,
        postHits: postHitsByName[name] || 0,
      });
      if (!scored) continue;
      const item = {
        name: c.display_name,
        canonical: name,
        candidate: c,
        alreadyLoaded: exclude.has(name),
        ...scored,
      };

      /* "Relevant" mode (formerly Strict): tighter than All but never
       * drops a known-good catalog member. Already-loaded subs always
       * pass through to the second section so the user can see their
       * existing set ranked.
       *
       * The bar is now: keep if any one of these is true —
       *   - already in your dashboard
       *   - in the curated catalog (any sphere)
       *   - sphereHits >= 2  (strong civic vocabulary)
       *   - sphereHits >= 1 AND themeMatch >= 0.15
       *   - themeMatch >= 0.30
       *   - postHits >= 2 (real recent activity on campaign keywords)
       * Otherwise drop. Plus mega-sub guard for raw-popularity giants. */
      if (strict && !item.alreadyLoaded && !item.isCatalogMember) {
        const subs = c.subscribers || 0;
        /* Off-topic dominates: drop. */
        if (item.offtopicHits >= 2 && item.themeMatch < 0.25 && item.sphereHits === 0) {
          droppedOfftopic++; continue;
        }
        const hasGoodSignal =
          item.sphereHits >= 2 ||
          (item.sphereHits >= 1 && item.themeMatch >= 0.15) ||
          item.themeMatch >= 0.30 ||
          item.postHits >= 2;
        if (!hasGoodSignal) { droppedWeak++; continue; }
        /* Mega-sub (>5M) without strong topical signal: drop. Catalog
         * members already exempt above. */
        if (subs > 5000000 && item.themeMatch < 0.40 && item.sphereHits < 2 && item.postHits < 3) {
          droppedMega++; continue;
        }
      }

      if (item.alreadyLoaded) alreadyOut.push(item);
      else newOut.push(item);
    }
    newOut.sort((a, b) => b.score - a.score);
    alreadyOut.sort((a, b) => b.score - a.score);
    /* Caps moved up to give the renderer enough material to paginate
     * over. The previous caps (20 new + 8 already-loaded) were just
     * the visible-list size; now the renderer slices its own page
     * so the engine returns the full ranked tail. 200/100 is enough
     * to surface every viable candidate without the JSON ballooning
     * (most discovery passes find ~50-150 viable candidates after
     * filtering anyway). */
    return {
      candidates: newOut.slice(0, opts.limit != null ? opts.limit : 200),
      alreadyLoaded: alreadyOut.slice(0, opts.alreadyLimit != null ? opts.alreadyLimit : 100),
      totalScanned: seen.size,
      filtered: { offtopic: droppedOfftopic, weak: droppedWeak, mega: droppedMega },
      strict: strict,
    };
  };

  /* Build a search query from a campaign's top phrases / keywords. */
  Analysis.buildDiscoveryQuery = function (campaignProfile) {
    const phrases = (campaignProfile.bigrams || []).slice(0, 2).map((b) => `"${b.phrase}"`);
    const words = (campaignProfile.keywords || []).slice(0, 4).map((k) => k.word);
    const parts = [...phrases, ...words.slice(0, 4 - phrases.length)];
    return parts.join(" OR ");
  };

  /* Returns N distinct query strings — one per top phrase plus one per top
   * keyword — so the discoverer can run them in parallel and union the
   * results. Words like "june", "answer", "thing", "today" are filtered
   * out so the queries stay topical. Subs that match multiple queries
   * get a frequency-of-hits boost in scoreCandidate. */
  Analysis.buildDiscoveryQuerySet = function (campaignProfile, n) {
    n = n || 6;
    const isTopical = (w) => !NON_TOPICAL_DISCOVERY_WORDS.has(w);
    const phrases = (campaignProfile.bigrams || [])
      .filter((b) => b.phrase.split(/\s+/).every(isTopical))
      .slice(0, 4)
      .map((b) => `"${b.phrase}"`);
    const words = (campaignProfile.keywords || [])
      .filter((k) => isTopical(k.word))
      .slice(0, 8)
      .map((k) => k.word);
    const out = [];
    for (const p of phrases) { if (out.length < n) out.push(p); }
    for (const w of words) { if (out.length < n) out.push(w); }
    return out;
  };

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
     CASCADE SCHEDULER (PR 5)
     ----------------------------------------------------------------
     Given a list of target subs and the user's loaded post data,
     recommend a STAGGERED posting order so each sub catches its own
     peak hour without piling on at once.

     Returns [{ sub, hourLocal, label, predictedScore, gapMinutes }]
     ordered chronologically across the next 24 hours.
     ============================================================ */

  Analysis.cascadeSchedule = function (subs, opts) {
    opts = opts || {};
    const posts = opts.posts || [];
    const subProfiles = opts.subProfiles || {};
    const minGapMinutes = opts.minGapMinutes || 60;

    const slots = [];
    const now = new Date();
    const nowHour = now.getHours();
    /* Build candidate slots: each sub's bestHour (and second-best
     * if it's strong), within the next 24 hours from now. */
    for (const sub of subs) {
      const key = String(sub).toLowerCase();
      const profile = subProfiles[key] || subProfiles[sub] || null;
      if (!profile) continue;
      const peakHour = profile.bestHour;
      if (peakHour == null || peakHour < 0) continue;
      /* Translate hour-of-day into the next clock instance >= now. */
      let hoursUntil = (peakHour - nowHour + 24) % 24;
      if (hoursUntil === 0) hoursUntil = 24;  /* always future */
      const targetTime = new Date(now.getTime() + hoursUntil * 3600 * 1000);
      targetTime.setMinutes(0, 0, 0);
      const pred = Analysis.predictPostScore(sub, null, { posts, hour: peakHour });
      slots.push({
        sub,
        hour: peakHour,
        targetTime,
        predictedMid: pred.expectedMid || profile.medianScore || 0,
        confidence: pred.confidence,
      });
    }
    /* Sort by target time ascending */
    slots.sort((a, b) => a.targetTime - b.targetTime);
    /* Resolve collisions: if two slots are within minGapMinutes of
     * each other, push the lower-predicted one forward by minGap. */
    for (let i = 1; i < slots.length; i++) {
      const prev = slots[i - 1];
      const cur = slots[i];
      const gap = (cur.targetTime - prev.targetTime) / 60000;
      if (gap < minGapMinutes) {
        cur.targetTime = new Date(prev.targetTime.getTime() + minGapMinutes * 60000);
      }
    }
    /* Compute display fields. */
    let prevTime = null;
    return slots.map((s) => {
      const gapMin = prevTime ? Math.round((s.targetTime - prevTime) / 60000) : 0;
      prevTime = s.targetTime;
      return {
        sub: s.sub,
        hourLocal: s.targetTime.getHours(),
        targetTime: s.targetTime,
        predictedScore: s.predictedMid,
        confidence: s.confidence,
        gapMinutes: gapMin,
      };
    });
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
      hint: "Activist vocabulary — works well in r/Political_Revolution, r/DemocraticSocialism, r/WorkReform",
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
