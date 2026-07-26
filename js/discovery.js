/* =====================================================================
 * DISCOVERY ENGINE
 * ---------------------------------------------------------------------
 * Finds subreddits whose audience matches an issue, and finds the
 * communities most similar to a given subreddit.
 *
 * HOW MATCHING WORKS NOW
 * Both sides of the comparison are turned into weighted term vectors and
 * scored by inverse-document-frequency-weighted cosine similarity:
 *
 *   campaign vector  <- post titles + flair, plus the terms of whichever
 *                       spheres the campaign scored against
 *   subreddit vector <- display name (x3) + title (x2) + public
 *                       description (x1), stemmed and stopword-filtered
 *
 * That replaces the previous approach, which counted raw substring hits
 * of campaign keywords inside the concatenated description. Substrings
 * matched "vote" inside "devoted", gave no credit for related-but-not-
 * identical vocabulary, and could not explain themselves beyond echoing
 * the keyword back.
 *
 * SPHERES ARE SCORED, NOT DETECTED
 * The curated catalog in js/seeds.js used to be consulted through a
 * hardcoded trigger table: if a campaign keyword appeared verbatim in
 * SPHERE_TRIGGERS, the sphere was "detected", otherwise it was invisible.
 * Here each sphere gets its own term vector — built from its label, its
 * trigger words, and the real descriptions of its member subreddits —
 * and every sphere is ranked by overlap with the campaign, with a
 * confidence value. A housing campaign now surfaces the tenancy sphere
 * because the vocabulary matches, not because someone remembered to add
 * "eviction" to a list.
 * ===================================================================== */
(function () {
  const Discovery = {};

  /* Cosine similarity over short, sparse documents rarely exceeds ~0.4
   * even for an obviously-on-topic pair, so raw values are rescaled
   * against this ceiling before being folded into the composite. */
  const SIM_CEILING = 0.32;

  /* Terms that signal a community is in the civic / organising space at
   * all. A candidate can match a campaign's exact vocabulary by accident
   * (r/AskHistorians discussing "labor unions"); this is the sanity
   * check that it is the right *kind* of community. */
  const CIVIC_TERMS = ([
    "politic political policy policies government governance legislation legislative",
    "activism activist organize organizing organiser organizer advocacy advocate",
    "protest march rally demonstration strike union labor labour worker workers",
    "vote voter voting ballot election elections campaign candidate democracy democratic",
    "progressive socialist leftist liberal conservative reform reformist",
    "rights justice equality equity injustice oppression liberation solidarity",
    "community mutual aid volunteer grassroots coalition movement",
    "healthcare medicare medicaid insurance housing tenant eviction rent",
    "climate environment immigration refugee asylum education tuition student",
    "abortion reproductive lgbtq queer trans racism racial feminist feminism",
    "congress senate parliament council mayor governor legislature court",
  ].join(" ")).split(/\s+/).filter(Boolean);

  /* Communities that reliably look topical on keywords but are not
   * audiences for civic outreach. */
  const OFFTOPIC_TERMS = ([
    "anime manga waifu cosplay fandom fanfic shipping",
    "gaming gamer videogame console playstation xbox nintendo steam speedrun",
    "celebrity gossip kardashian influencer tiktok onlyfans",
    "porn nsfw hentai gonewild nude",
    "crypto bitcoin ethereum nft altcoin memecoin trading daytrading",
    "sports football basketball baseball hockey soccer fantasy nfl nba mlb",
    "recipe cooking baking food restaurant",
    "meme memes shitpost circlejerk copypasta",
    "makeup skincare fashion sneakers watches",
    "dating relationship tinder hookup",
    "movie movies television netflix marvel starwars",
  ].join(" ")).split(/\s+/).filter(Boolean);

  Discovery.CIVIC_TERMS = CIVIC_TERMS;
  Discovery.OFFTOPIC_TERMS = OFFTOPIC_TERMS;

  const civicVector = SubIndex.vectorFromText(CIVIC_TERMS.join(" "), 1);
  const offtopicSet = new Set(OFFTOPIC_TERMS.map((t) => SubIndex.stem(t)));

  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  function rescale(sim) {
    return clamp01(sim / SIM_CEILING);
  }

  /* ==================================================================
   * CAMPAIGN VECTOR
   * ================================================================== */

  /* Build the term vector that represents what a campaign is *about*.
   * Titles carry the message, flair carries the framing the community
   * itself applied, so both are used at different weights. */
  Discovery.campaignVector = function (posts, profile) {
    const vec = {};
    for (const p of posts || []) {
      SubIndex.addText(vec, p.title || "", 3);
      if (p.flair) SubIndex.addText(vec, p.flair, 1);
    }
    /* The profile's extracted keywords and bigrams are already
     * frequency-ranked, so folding them back in sharpens the peaks
     * without changing the shape. */
    if (profile) {
      for (const k of (profile.keywords || []).slice(0, 20)) {
        SubIndex.addText(vec, k.word || "", Math.min(3, 1 + Math.log2(1 + (k.count || 1))));
      }
      for (const b of (profile.bigrams || []).slice(0, 12)) {
        SubIndex.addText(vec, b.phrase || "", 2);
      }
    }
    return vec;
  };

  /* Free-text vector, for the search box and for issue-only discovery
   * where there is no campaign yet. */
  Discovery.textVector = function (text) {
    return SubIndex.vectorFromText(text || "", 2);
  };

  /* ==================================================================
   * SPHERE PROFILES
   * ================================================================== */

  let sphereCache = null;
  let sphereCacheSize = -1;

  /* One term vector per sphere. Built from the human label, the sphere's
   * trigger vocabulary, the member subreddit names, and — for any member
   * we have already indexed — its real title and description. The index
   * grows as the user explores, so sphere vectors get sharper over time;
   * the cache is keyed on index size so it rebuilds when that happens. */
  Discovery.sphereProfiles = function () {
    if (sphereCache && sphereCacheSize === SubIndex.size()) return sphereCache;
    if (!window.Seeds) return [];

    const out = [];

    function build(key, members, kind) {
      const vec = {};
      SubIndex.addText(vec, Seeds.labelOf(key), 3);
      const triggers = (Seeds.SPHERE_TRIGGERS && Seeds.SPHERE_TRIGGERS[key])
        || (Seeds.DEMOGRAPHIC_TRIGGERS && Seeds.DEMOGRAPHIC_TRIGGERS[key])
        || [];
      SubIndex.addText(vec, triggers.join(" "), 2.5);

      let described = 0;
      for (const name of members) {
        SubIndex.addText(vec, name, 1.2);
        const record = SubIndex.get(name);
        if (record) {
          described++;
          SubIndex.addText(vec, record.title || "", 0.8);
          SubIndex.addText(vec, record.public_description || "", 0.5);
        }
      }

      out.push({
        key: key,
        kind: kind,
        label: Seeds.labelOf(key),
        subs: members,
        describedCount: described,
        vector: vec,
      });
    }

    for (const [key, members] of Object.entries(Seeds.ISSUE_SPHERES || {})) build(key, members, "issue");
    for (const [key, members] of Object.entries(Seeds.DEMOGRAPHIC_SPHERES || {})) build(key, members, "audience");
    for (const [key, members] of Object.entries(Seeds.STATE_SPHERES || {})) build(key, members, "state");

    sphereCache = out;
    sphereCacheSize = SubIndex.size();
    return out;
  };

  Discovery.invalidateSpheres = function () {
    sphereCache = null;
    sphereCacheSize = -1;
  };

  /* Rank every sphere against a campaign (or free-text) vector.
   * Geographic spheres are excluded by default: state vocabulary is
   * mostly place names, so they match on coincidence rather than issue
   * alignment and are better chosen deliberately. */
  Discovery.rankSpheres = function (vector, opts) {
    opts = opts || {};
    const profiles = Discovery.sphereProfiles()
      .filter((s) => (opts.includeStates ? true : s.kind !== "state"));
    if (!profiles.length) return [];

    const idf = SubIndex.buildIdf(profiles.map((s) => s.vector));
    const ranked = profiles.map((sphere) => {
      const sim = SubIndex.cosine(vector, sphere.vector, idf);
      return {
        key: sphere.key,
        kind: sphere.kind,
        label: sphere.label,
        subs: sphere.subs,
        score: sim,
        confidence: Math.round(rescale(sim) * 100),
        terms: SubIndex.overlapTerms(vector, sphere.vector, 5).map((t) => t.term),
      };
    });

    ranked.sort((a, b) => b.score - a.score);
    const floor = opts.minConfidence == null ? 12 : opts.minConfidence;
    const kept = ranked.filter((s) => s.confidence >= floor);
    return kept.slice(0, opts.limit || 8);
  };

  /* ==================================================================
   * CANDIDATE SCORING
   * ================================================================== */

  function engagementScore(record, subProfile) {
    /* A loaded sub gives us real behaviour; otherwise fall back to
     * Reddit's active-user count, and finally to subscribers-per-day
     * since creation as a crude growth proxy. */
    if (subProfile && subProfile.count) {
      const commentsPerPost = subProfile.avgComments || 0;
      return clamp01(Math.log10(1 + commentsPerPost) / 2);
    }
    if (record.active_user_count > 0 && record.subscribers > 0) {
      return clamp01(Math.log10(1 + record.active_user_count) / 4);
    }
    if (record.subscribers > 0 && record.created_utc > 0) {
      const days = Math.max(1, (Date.now() / 1000 - record.created_utc) / 86400);
      return clamp01(Math.log10(1 + record.subscribers / days) / 2);
    }
    return 0.25;
  }

  function offtopicHits(record) {
    const terms = SubIndex.tokenize(
      (record.display_name || "") + " " + (record.title || "") + " " + (record.public_description || "")
    );
    let hits = 0;
    for (const t of terms) if (offtopicSet.has(t)) hits++;
    return hits;
  }

  /* Score one candidate. `ctx` carries the campaign vector, the ranked
   * spheres, the idf table, and the per-name hit tallies from search and
   * post mining. */
  Discovery.scoreCandidate = function (record, ctx) {
    const vec = record.vector || SubIndex.vectorFor(record);

    const themeSim = SubIndex.cosine(ctx.vector, vec, ctx.idf);
    const theme = rescale(themeSim);

    /* Best-matching sphere, and the alignment with civic vocabulary in
     * general. A sub can be strongly on-theme without being civic (a
     * news aggregator) or civic without being on-theme (a generic
     * politics sub) — both matter, differently. */
    let bestSphere = null;
    let sphereSim = 0;
    for (const sphere of ctx.spheres || []) {
      const sim = SubIndex.cosine(sphere.vector || sphere._vector || {}, vec, ctx.idf);
      if (sim > sphereSim) {
        sphereSim = sim;
        bestSphere = sphere;
      }
    }
    const sphereScore = rescale(sphereSim);
    const civic = rescale(SubIndex.cosine(civicVector, vec, ctx.idf));

    const popularity = clamp01(Math.log10((record.subscribers || 0) + 10) / 6);
    const subProfile = ctx.subProfiles && ctx.subProfiles[record.key];
    const engagement = engagementScore(record, subProfile);

    const queryHits = (ctx.queryHits && ctx.queryHits[record.key]) || 0;
    const postHits = (ctx.postHits && ctx.postHits[record.key]) || 0;
    const queryBoost = clamp01(queryHits / 4);
    const postBoost = clamp01(postHits / 8);

    const catalogSpheres = window.Seeds ? Seeds.spheresOf(record.display_name) : [];
    const catalogBoost = catalogSpheres.length ? 0.12 : 0;

    const offtopic = offtopicHits(record);
    const offtopicPenalty = clamp01(offtopic / 3);

    /* A sub with 8 million subscribers matches almost any vocabulary by
     * sheer surface area. Discount its popularity contribution unless it
     * is genuinely on-theme. */
    const megaGeneric = (record.subscribers || 0) > 3000000 && theme < 0.35;
    const popularityEffective = megaGeneric ? popularity * 0.2 : popularity;

    let raw =
      0.34 * theme +
      0.20 * sphereScore +
      0.10 * civic +
      0.09 * engagement +
      0.07 * popularityEffective +
      0.06 * postBoost +
      0.04 * queryBoost +
      catalogBoost;
    raw -= 0.26 * offtopicPenalty;

    const composite = clamp01(raw);
    const overlap = SubIndex.overlapTerms(ctx.vector, vec, 6);

    return {
      key: record.key,
      name: record.display_name,
      record: record,
      score: Math.round(composite * 100),
      composite: composite,
      signals: {
        theme: theme,
        themeSim: themeSim,
        sphere: sphereScore,
        sphereKey: bestSphere ? bestSphere.key : null,
        sphereLabel: bestSphere ? bestSphere.label : null,
        civic: civic,
        engagement: engagement,
        popularity: popularity,
        queryHits: queryHits,
        postHits: postHits,
        offtopic: offtopic,
        catalog: catalogSpheres,
        megaGeneric: megaGeneric,
      },
      overlapTerms: overlap,
      reasons: buildReasons(record, overlap, {
        theme: theme, sphere: sphereScore, civic: civic,
        bestSphere: bestSphere, queryHits: queryHits, postHits: postHits,
        catalogSpheres: catalogSpheres, offtopic: offtopic,
        megaGeneric: megaGeneric, engagement: engagement,
      }),
    };
  };

  /* Reasons name the actual overlapping vocabulary rather than restating
   * the score, so a user can judge whether the match is real. */
  function buildReasons(record, overlap, s) {
    const esc = window.Util ? Util.escapeHtml : (x) => String(x);
    const out = [];

    if (overlap.length) {
      const words = overlap.slice(0, 5).map((t) => `<code>${esc(t.term)}</code>`).join(" ");
      out.push(`Shares ${overlap.length === 1 ? "the term" : "vocabulary"} ${words} with your campaign`);
    } else {
      out.push("No direct vocabulary overlap — surfaced by sphere or activity signals");
    }

    if (s.bestSphere && s.sphere > 0.25) {
      out.push(`Reads as a <strong>${esc(s.bestSphere.label)}</strong> community (${Math.round(s.sphere * 100)}% sphere fit)`);
    }
    if (s.catalogSpheres && s.catalogSpheres.length) {
      const labels = s.catalogSpheres
        .slice(0, 2)
        .map((k) => esc(Seeds.labelOf(k.replace(/^(state|demo):/, ""))))
        .join(", ");
      out.push(`In the curated catalog under ${labels}`);
    }
    if (s.postHits >= 2) {
      out.push(`${s.postHits} recent top posts on your keywords came from here`);
    }
    if (s.queryHits >= 2) {
      out.push(`Matched ${s.queryHits} of the search angles independently`);
    }
    if (record.subscribers) {
      const fmt = window.Util ? Util.fmtNum : (n) => String(n);
      out.push(`${fmt(record.subscribers)} subscribers${record.active_user_count ? ` · ${fmt(record.active_user_count)} online` : ""}`);
    }
    if (s.megaGeneric) {
      out.push("Very large and broadly-scoped — expect a low signal-to-noise ratio");
    }
    if (s.offtopic >= 2) {
      out.push("Description contains off-topic vocabulary (entertainment / gaming / crypto)");
    }
    if (s.civic < 0.1) {
      out.push("Not obviously a civic or organising space");
    }
    return out;
  }

  /* ==================================================================
   * FILTERING
   * ================================================================== */

  /* Relevant mode. Kept as a pure function over already-scored
   * candidates so toggling Relevant / All re-filters instantly instead
   * of requiring a fresh multi-second discovery run — the previous build
   * only applied the toggle on the next run, which made it look broken.
   */
  Discovery.applyFilter = function (scored, strict) {
    if (!strict) {
      return { kept: scored.slice(), dropped: { offtopic: 0, weak: 0, mega: 0 } };
    }
    const kept = [];
    const dropped = { offtopic: 0, weak: 0, mega: 0 };
    for (const c of scored) {
      const s = c.signals;
      /* Catalog members are curated by hand; never filter them out. */
      if (s.catalog && s.catalog.length) { kept.push(c); continue; }

      if (s.offtopic >= 2 && s.theme < 0.3) { dropped.offtopic++; continue; }
      if (s.megaGeneric && s.postHits < 3 && s.sphere < 0.3) { dropped.mega++; continue; }

      const strongEnough =
        s.theme >= 0.28 ||
        s.sphere >= 0.3 ||
        (s.theme >= 0.15 && s.sphere >= 0.18) ||
        s.postHits >= 2;
      if (!strongEnough) { dropped.weak++; continue; }

      kept.push(c);
    }
    return { kept: kept, dropped: dropped };
  };

  /* Re-derive the visible lists from a stashed run at a new strictness.
   * No network, no re-scoring. */
  Discovery.refilter = function (result, strict) {
    if (!result || !result.scored) return result;
    const filtered = Discovery.applyFilter(result.scored, strict);
    const exclude = result.excludeSet || new Set();
    const candidates = [];
    const alreadyLoaded = [];
    for (const c of filtered.kept) {
      if (exclude.has(c.key)) alreadyLoaded.push(c);
      else candidates.push(c);
    }
    return Object.assign({}, result, {
      strict: !!strict,
      candidates: candidates,
      alreadyLoaded: alreadyLoaded,
      filtered: filtered.dropped,
    });
  };

  /* ==================================================================
   * THE PIPELINE
   * ================================================================== */

  /* Run discovery for a campaign (or a free-text issue).
   *
   *   opts.posts        campaign posts, used to build the term vector
   *   opts.profile      Analysis.campaignProfile output (optional)
   *   opts.text         free-text issue, used when there are no posts
   *   opts.spheres      manually-pinned sphere keys
   *   opts.exclude      sub names to mark as already-loaded
   *   opts.strict       Relevant mode
   *   opts.subProfiles  loaded-sub profiles for real engagement numbers
   *   opts.onProgress   (pct, message)
   */
  Discovery.run = async function (opts) {
    opts = opts || {};
    const report = typeof opts.onProgress === "function" ? opts.onProgress : function () {};
    await SubIndex.load();

    const vector = (opts.posts && opts.posts.length)
      ? Discovery.campaignVector(opts.posts, opts.profile)
      : Discovery.textVector(opts.text || "");

    if (!Object.keys(vector).length) {
      throw new Error("Not enough content to build a topic profile. Add posts to the campaign first.");
    }

    /* ---- Phase 0: which spheres does this campaign look like? ---- */
    report(4, "Matching the campaign against issue spheres…");
    const pinned = new Set((opts.spheres || []).map(String));
    const autoSpheres = Discovery.rankSpheres(vector, { limit: 6 });
    const sphereByKey = new Map(Discovery.sphereProfiles().map((s) => [s.key, s]));

    const activeSpheres = [];
    const seenSphere = new Set();
    for (const s of autoSpheres) {
      if (seenSphere.has(s.key)) continue;
      seenSphere.add(s.key);
      activeSpheres.push(Object.assign({ auto: true }, s, { vector: (sphereByKey.get(s.key) || {}).vector }));
    }
    for (const key of pinned) {
      if (seenSphere.has(key)) continue;
      const profile = sphereByKey.get(key);
      if (!profile) continue;
      seenSphere.add(key);
      activeSpheres.push({
        key: key, kind: profile.kind, label: profile.label, subs: profile.subs,
        vector: profile.vector, auto: false, confidence: null, terms: [],
      });
    }

    /* ---- Phase 1: multi-angle subreddit search ---- */
    const queries = Discovery.buildQueries(vector, opts.profile, 6);
    const queryHits = {};
    const found = new Map();

    if (queries.length && window.Reddit) {
      let done = 0;
      await Util.pmap(queries, 2, async (q) => {
        try {
          const results = await Reddit.searchSubreddits(q, { limit: 15 });
          for (const raw of results) {
            const record = SubIndex.put(raw, { partial: true });
            if (!record) continue;
            found.set(record.key, record);
            queryHits[record.key] = (queryHits[record.key] || 0) + 1;
          }
        } catch (err) {
          console.warn(`[discovery] search "${q}":`, err && err.message);
        } finally {
          done++;
          report(4 + 26 * (done / queries.length), `Searching Reddit · ${done}/${queries.length} angles · ${found.size} subs`);
        }
      });
    }

    /* ---- Phase 2: mine recent top posts for active communities ---- */
    const postHits = {};
    const postQuery = Discovery.topTerms(vector, 4).join(" ");
    if (postQuery && window.Reddit) {
      report(32, "Mining recent top posts for active communities…");
      try {
        const posts = await Reddit.searchPosts(postQuery, { limit: 75, sort: "top", t: "month" });
        for (const p of posts) {
          const key = (p.subreddit || "").toLowerCase();
          if (!key) continue;
          postHits[key] = (postHits[key] || 0) + 1;
        }
      } catch (err) {
        console.warn("[discovery] post mining:", err && err.message);
      }
    }

    /* ---- Phase 3: seed from the spheres that scored ---- */
    const seedNames = [];
    for (const sphere of activeSpheres) {
      for (const name of sphere.subs || []) seedNames.push(name);
    }

    /* ---- Phase 4: make sure every candidate has real metadata ----
     * This is the change that makes description matching trustworthy.
     * Previously most candidates were scored on whatever the search
     * endpoint returned and only a couple of dozen ever got about.json;
     * now every name in play is resolved through the index, which caches
     * for 30 days so a second run is nearly free. */
    const minedNames = Object.keys(postHits)
      .sort((a, b) => postHits[b] - postHits[a])
      .slice(0, 20);

    const allNames = Array.from(new Set(
      Array.from(found.keys())
        .concat(minedNames)
        .concat(seedNames.map((n) => String(n)))
    ));

    report(38, `Reading community descriptions · 0/${allNames.length}`);
    await SubIndex.ensure(allNames, {
      limit: opts.aboutBudget == null ? 90 : opts.aboutBudget,
      concurrency: 4,
      onProgress: (done, total, name) => {
        report(38 + 46 * (done / Math.max(1, total)), `Reading r/${name} · ${done}/${total} descriptions`);
      },
    });

    /* Sphere vectors sharpen once their members are described. */
    Discovery.invalidateSpheres();
    const refreshed = new Map(Discovery.sphereProfiles().map((s) => [s.key, s]));
    for (const sphere of activeSpheres) {
      const fresh = refreshed.get(sphere.key);
      if (fresh) sphere.vector = fresh.vector;
    }

    /* ---- Phase 5: score ---- */
    report(88, "Scoring candidates…");
    const records = [];
    for (const name of allNames) {
      const record = SubIndex.get(name);
      if (!record) continue;
      if (record.over18) continue;
      if ((record.subscribers || 0) < (opts.minSubs == null ? 25 : opts.minSubs)) continue;
      records.push(record);
    }

    const idf = SubIndex.buildIdf(records.map((r) => r.vector).concat([vector]));
    const ctx = {
      vector: vector,
      idf: idf,
      spheres: activeSpheres,
      queryHits: queryHits,
      postHits: postHits,
      subProfiles: opts.subProfiles || {},
    };

    const scored = records.map((r) => Discovery.scoreCandidate(r, ctx));
    scored.sort((a, b) => b.composite - a.composite);

    const excludeSet = new Set((opts.exclude || []).map((s) => String(s).toLowerCase()));

    const result = {
      scored: scored,
      excludeSet: excludeSet,
      totalScanned: records.length,
      queries: queries,
      spheres: activeSpheres,
      autoSpheres: autoSpheres,
      vector: vector,
      topTerms: Discovery.topTerms(vector, 12),
      postsMined: Object.keys(postHits).length,
    };

    report(100, "Done");
    return Discovery.refilter(result, opts.strict !== false);
  };

  /* The highest-weight terms in a vector, single words only (bigrams
   * make poor search queries against Reddit's index). */
  Discovery.topTerms = function (vector, limit) {
    return Object.entries(vector || {})
      .filter(([term]) => term.indexOf(" ") === -1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit || 10)
      .map(([term]) => term);
  };

  /* Split the campaign's vocabulary into several independent search
   * angles. One combined query returns one neighbourhood; several
   * narrow ones reach further, and a sub appearing in more than one is
   * a stronger signal than a sub appearing in the biggest. */
  Discovery.buildQueries = function (vector, profile, n) {
    const count = n || 6;
    const queries = [];

    /* Phrases first — they are the most specific thing we know. */
    const phrases = Object.entries(vector || {})
      .filter(([term]) => term.indexOf(" ") > -1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([term]) => term);
    for (const phrase of phrases) queries.push(`"${phrase}"`);

    const terms = Discovery.topTerms(vector, 12);
    /* Pair terms up so each query has enough specificity to avoid
     * returning the default-front-page subs. */
    for (let i = 0; i < terms.length && queries.length < count; i += 2) {
      const pair = terms.slice(i, i + 2).filter(Boolean);
      if (pair.length) queries.push(pair.join(" "));
    }

    if (!queries.length && profile && profile.keywords && profile.keywords.length) {
      queries.push(profile.keywords.slice(0, 3).map((k) => k.word).join(" "));
    }
    return queries.slice(0, count);
  };

  /* ==================================================================
   * SIMILAR COMMUNITIES
   * ------------------------------------------------------------------
   * Reddit exposes no public "related subreddits" endpoint, so this is
   * derived from four independent signals. Each result records which
   * ones contributed, and the UI shows that, because a neighbour found
   * only by post co-occurrence deserves less trust than one that also
   * matches on description.
   * ================================================================== */

  Discovery.findSimilar = async function (name, opts) {
    opts = opts || {};
    await SubIndex.load();

    const target = (await SubIndex.ensure([name], { limit: 1 }))[0] || SubIndex.get(name);
    if (!target) throw new Error(`Could not read r/${name}.`);

    const key = target.key;
    const pool = new Map(); /* key -> { name, sources:Set, score, record } */

    function note(subName, source, weight) {
      const k = String(subName || "").toLowerCase();
      if (!k || k === key) return;
      if (!pool.has(k)) pool.set(k, { key: k, name: subName, sources: new Set(), weight: 0 });
      const entry = pool.get(k);
      entry.sources.add(source);
      entry.weight += weight;
    }

    /* 1. Nearest neighbours in the local index, by description vector. */
    const near = SubIndex.nearest(target.vector, { exclude: [key], limit: 20 });
    for (const hit of near) note(hit.record.display_name, "description", hit.score * 2);

    /* 2. Sphere co-membership from the curated catalog. */
    if (window.Seeds) {
      for (const sphereKey of Seeds.spheresOf(target.display_name)) {
        const clean = sphereKey.replace(/^(state|demo):/, "");
        for (const member of Seeds.expand([clean])) note(member, "catalog", 0.35);
      }
    }

    /* 3. Live subreddit search on the target's own strongest terms. */
    const terms = Discovery.topTerms(target.vector, 5);
    if (terms.length && window.Reddit && opts.live !== false) {
      const query = terms.slice(0, 3).join(" ");
      try {
        const results = await Reddit.searchSubreddits(query, { limit: 20 });
        for (const raw of results) {
          const record = SubIndex.put(raw, { partial: true });
          if (record) note(record.display_name, "search", 0.3);
        }
      } catch (err) {
        console.warn("[discovery] similar search:", err && err.message);
      }
    }

    /* 4. Post co-occurrence: take this sub's own top posts, search those
     *    titles site-wide, and see which other communities are talking
     *    about the same things right now. */
    if (window.Reddit && opts.live !== false && opts.mine !== false) {
      try {
        const posts = await Reddit.fetchSubredditListing(target.display_name, {
          listing: "top", limit: 25, t: "month",
        }) || [];
        const titleTerms = {};
        for (const p of posts.slice(0, 15)) {
          for (const t of SubIndex.tokenize(p.title || "")) titleTerms[t] = (titleTerms[t] || 0) + 1;
        }
        const query = Object.entries(titleTerms)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([t]) => t)
          .join(" ");
        if (query) {
          const found = await Reddit.searchPosts(query, { limit: 60, sort: "top", t: "month" });
          const counts = {};
          for (const p of found) {
            const k = (p.subreddit || "").toLowerCase();
            if (!k || k === key) continue;
            counts[k] = (counts[k] || 0) + 1;
          }
          for (const [k, n] of Object.entries(counts)) {
            if (n < 2) continue;
            note(k, "co-posting", Math.min(0.5, n / 10));
          }
        }
      } catch (err) {
        console.warn("[discovery] similar mining:", err && err.message);
      }
    }

    /* Resolve metadata for the strongest handful, then re-score against
     * the target's own vector so ranking reflects real descriptions. */
    const shortlist = Array.from(pool.values())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, opts.limit ? opts.limit * 2 : 24);

    await SubIndex.ensure(shortlist.map((e) => e.name), { limit: 24, concurrency: 4 });

    const records = shortlist.map((e) => SubIndex.get(e.name)).filter(Boolean);
    const idf = SubIndex.buildIdf(records.map((r) => r.vector).concat([target.vector]));

    const out = [];
    for (const entry of shortlist) {
      const record = SubIndex.get(entry.name);
      if (!record || record.over18) continue;
      const sim = SubIndex.cosine(target.vector, record.vector, idf);
      /* A neighbour confirmed by more than one independent signal is
       * more trustworthy than one found by a single lucky search. */
      const agreement = 1 + 0.25 * (entry.sources.size - 1);
      out.push({
        name: record.display_name,
        record: record,
        similarity: rescale(sim),
        score: Math.round(clamp01(rescale(sim) * 0.7 * agreement + Math.min(0.3, entry.weight * 0.3)) * 100),
        sources: Array.from(entry.sources),
        terms: SubIndex.overlapTerms(target.vector, record.vector, 4).map((t) => t.term),
      });
    }

    out.sort((a, b) => b.score - a.score);
    return { target: target, similar: out.slice(0, opts.limit || 12) };
  };

  /* ==================================================================
   * SEARCH
   * ------------------------------------------------------------------
   * Powers the Communities search box. Merges cached index hits (instant)
   * with live autocomplete and full search (authoritative), deduped.
   * ================================================================== */

  Discovery.searchSubreddits = async function (query, opts) {
    opts = opts || {};
    await SubIndex.load();
    const q = String(query || "").trim();
    if (!q) return [];

    const byKey = new Map();
    function add(record, source) {
      if (!record) return;
      if (!byKey.has(record.key)) byKey.set(record.key, { record: record, sources: [source] });
      else byKey.get(record.key).sources.push(source);
    }

    for (const record of SubIndex.searchLocal(q, 8)) add(record, "cache");

    if (window.Reddit && opts.live !== false) {
      const tasks = [
        Reddit.autocompleteSubreddits(q, { limit: 10 }).catch(() => []),
        Reddit.searchSubreddits(q, { limit: 20 }).catch(() => []),
      ];
      const [auto, full] = await Promise.all(tasks);
      for (const raw of auto) add(SubIndex.put(raw, { partial: true }), "autocomplete");
      for (const raw of full) add(SubIndex.put(raw, { partial: true }), "search");
    }

    const queryVector = Discovery.textVector(q);
    const entries = Array.from(byKey.values());
    const idf = SubIndex.buildIdf(entries.map((e) => e.record.vector));

    const results = entries.map((entry) => {
      const record = entry.record;
      const exact = record.key === q.toLowerCase().replace(/^\/?r\//, "");
      const prefix = record.key.startsWith(q.toLowerCase().replace(/^\/?r\//, ""));
      const relevance = SubIndex.cosine(queryVector, record.vector, idf);
      const popularity = clamp01(Math.log10((record.subscribers || 0) + 10) / 6);
      return {
        record: record,
        name: record.display_name,
        exact: exact,
        sources: entry.sources,
        spheres: window.Seeds ? Seeds.spheresOf(record.display_name) : [],
        rank: (exact ? 2 : 0) + (prefix ? 0.6 : 0) + rescale(relevance) + popularity * 0.5,
      };
    });

    results.sort((a, b) => b.rank - a.rank);
    return results.slice(0, opts.limit || 25);
  };

  window.Discovery = Discovery;
})();
