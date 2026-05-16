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
    const limit = opts.limit || 10;
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
     14. CANDIDATE DISCOVERY
     ------------------------------------------------------------
     Score brand-new subreddits (returned from /subreddits/search)
     against a campaign profile, using only the candidate's
     description, name and basic stats — no need to fetch its
     posts up-front. Posts can be loaded later for deeper scoring
     once the user adds the candidate to the dashboard.
     ============================================================ */

  Analysis.scoreCandidate = function (candidate, campaignProfile) {
    if (!candidate || !campaignProfile) return null;
    const text = ((candidate.title || "") + " " +
                  (candidate.public_description || "") + " " +
                  (candidate.display_name || "")).toLowerCase();

    const camKeys = (campaignProfile.keywords || []).slice(0, 14).map((k) => k.word);
    const camPhrases = (campaignProfile.bigrams || []).slice(0, 8).map((b) => b.phrase);

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

    const composite = clamp01(
      0.55 * themeMatch +
      0.18 * popularity +
      0.20 * engagement +
      0.07 * safety
    );
    const score = Math.round(composite * 100);

    const reasons = [];
    if (matchedPhrases.length) reasons.push(`description matches <em>${matchedPhrases.map(htmlSafe).join(", ")}</em>`);
    if (matchedKeys.length) reasons.push(`description keyword overlap <em>${matchedKeys.slice(0, 6).map(htmlSafe).join(", ")}</em>`);
    if (!matchedPhrases.length && !matchedKeys.length) reasons.push(`<span class="meta">no direct keyword match — ranked on size + activity only</span>`);
    reasons.push(`<strong>${Util.fmtNum(subs)}</strong> subscribers`);
    if (candidate.active_user_count) {
      const pct = (ratio * 100).toFixed(2);
      reasons.push(`<strong>${Util.fmtNum(candidate.active_user_count)}</strong> active right now (${pct}% of subs)`);
    }
    return {
      score, composite,
      themeMatch, popularity, engagement,
      matchedKeys, matchedPhrases,
      reasons,
    };
  };

  Analysis.discoverCandidates = function (rawSearchResults, campaignProfile, opts) {
    opts = opts || {};
    const exclude = new Set(((opts.excludeNames || []).map((s) => String(s).toLowerCase())));
    const minSubs = opts.minSubs || 100;
    const seen = new Set();
    const out = [];
    for (const c of (rawSearchResults || [])) {
      if (!c || !c.display_name) continue;
      const name = String(c.display_name).toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      if (exclude.has(name)) continue;
      if (c.over18) continue;
      if ((c.subscribers || 0) < minSubs) continue;
      const scored = Analysis.scoreCandidate(c, campaignProfile);
      if (!scored) continue;
      out.push({
        name: c.display_name,
        canonical: name,
        candidate: c,
        ...scored,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, opts.limit || 12);
  };

  /* Build a search query from a campaign's top phrases / keywords. */
  Analysis.buildDiscoveryQuery = function (campaignProfile) {
    const phrases = (campaignProfile.bigrams || []).slice(0, 2).map((b) => `"${b.phrase}"`);
    const words = (campaignProfile.keywords || []).slice(0, 4).map((k) => k.word);
    const parts = [...phrases, ...words.slice(0, 4 - phrases.length)];
    return parts.join(" OR ");
  };

  window.Analysis = Analysis;
})();
