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
 *
 * That confidence is then carried all the way into candidate scoring.
 * How well a community embodies a sphere and whether the campaign
 * belongs to that sphere are separate questions, and conflating them
 * was the whole of a class of bad suggestions: one incidental word
 * ranked a sphere, and every hand-curated member of that sphere then
 * scored as a perfect match for a campaign with nothing to do with it.
 * ===================================================================== */
(function () {
  const Discovery = {};

  /* Cosine similarity over short, sparse documents rarely exceeds ~0.4
   * even for an obviously-on-topic pair, so raw values are rescaled
   * against this ceiling before being folded into the composite. */
  const SIM_CEILING = 0.32;

  /* Below this, the best-matching sphere is indistinguishable from
   * coincidental word overlap and no sphere is offered at all. */
  const MIN_SPHERE_SIGNAL = 0.012;

  /* How much a sphere's curated vocabulary counts for, and how much of
   * that a multi-word entry passes down to its individual words. */
  const TRIGGER_WEIGHT = 2.5;
  const PHRASE_WORD_SHARE = 0.24;

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
    /* Scripted-television vocabulary specifically. A show sub's blurb
     * ("Subreddit for the CBS television series … Starring …") otherwise
     * registered a single off-topic hit, one short of the threshold that
     * would have kept r/PersonOfInterest out of a civic campaign. */
    "series episode episodes seasons sitcom starring spoilers rewatch",
    "cinema actor actress screenwriter hbo hulu showtime",
  ].join(" ")).split(/\s+/).filter(Boolean);

  Discovery.CIVIC_TERMS = CIVIC_TERMS;
  Discovery.OFFTOPIC_TERMS = OFFTOPIC_TERMS;

  const civicVector = SubIndex.vectorFromText(CIVIC_TERMS.join(" "), 1);
  const offtopicSet = new Set(OFFTOPIC_TERMS.map((t) => SubIndex.stem(t)));

  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  /* The `limit` heaviest terms of a vector. */
  function trimVector(vec, limit) {
    const entries = Object.entries(vec);
    if (entries.length <= limit) return vec;
    entries.sort((a, b) => b[1] - a[1]);
    const out = {};
    for (let i = 0; i < limit; i++) out[entries[i][0]] = entries[i][1];
    return out;
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
    const subs = new Set();
    for (const p of posts || []) {
      SubIndex.addText(vec, p.title || "", 3);
      if (p.flair) SubIndex.addText(vec, p.flair, 1);
      if (p.subreddit) subs.add(p.subreddit);
    }

    /* Where a campaign already posted is evidence about what it is
     * about, and it disambiguates titles that read across two issues —
     * "single-payer polling is at 63%" is voting vocabulary and
     * healthcare vocabulary in one sentence, but r/MedicareForAll and
     * r/publichealth settle the question. Weighted below the titles:
     * a cross-post into a broad sub should not redefine the campaign. */
    for (const name of subs) {
      SubIndex.addText(vec, name, 1.5);
      const record = SubIndex.get(name);
      if (record) {
        SubIndex.addText(vec, record.title || "", 1);
        SubIndex.addText(vec, record.public_description || "", 0.8);
      }
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
      /* One entry at a time, not one call for the joined list.
       * addText also emits bigrams, at 1.5x the weight of a single
       * term, so joining the list into a sentence invented a bigram
       * for every adjacent *pair of unrelated list entries* — the
       * labor sphere was carrying "steward strikefund" and the racial
       * justice sphere "floyd policing" as its heaviest features. They
       * outweighed every real term, and because the vector is then
       * trimmed to its 64 largest entries they crowded out the member
       * descriptions the trim was supposed to preserve.
       *
       * Multi-word entries then get their halves discounted, because a
       * phrase can identify an issue when neither of its words does.
       * "sanctuary city" is unmistakably immigration vocabulary; at
       * full weight it also made "city" an immigration term, and a
       * post about a city cutting bus frequency ranked the immigration
       * sphere above half the catalog. The phrase keeps the weight,
       * its words keep a trace. */
      for (const phrase of triggers) {
        const terms = SubIndex.tokenize(phrase);
        if (!terms.length) continue;
        if (terms.length === 1) {
          vec[terms[0]] = (vec[terms[0]] || 0) + TRIGGER_WEIGHT;
          continue;
        }
        for (const t of terms) vec[t] = (vec[t] || 0) + TRIGGER_WEIGHT * PHRASE_WORD_SHARE;
        for (const b of SubIndex.bigrams(terms)) vec[b] = (vec[b] || 0) + TRIGGER_WEIGHT * 1.5;
      }

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
        /* Trimmed to the discriminative core. A sphere accumulates one
         * token per member name plus every word of every description,
         * so its norm grows with membership — and because cosine divides
         * by that norm, a big well-documented sphere would score *lower*
         * against a short campaign than a thin one. Keeping the heaviest
         * terms removes the long tail without losing the vocabulary that
         * actually identifies the issue. */
        vector: trimVector(vec, 64),
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
    const ranked = profiles.map((sphere) => ({
      key: sphere.key,
      kind: sphere.kind,
      label: sphere.label,
      subs: sphere.subs,
      score: SubIndex.cosine(vector, sphere.vector, idf),
      terms: SubIndex.overlapTerms(vector, sphere.vector, 5).map((t) => t.term),
    }));

    ranked.sort((a, b) => b.score - a.score);

    /* A campaign is usually a handful of post titles, so absolute cosine
     * against a sphere stays small even for an unmistakable match. What
     * the user needs is "how strongly does this sphere match relative to
     * the others", so confidence is expressed against the best match —
     * gated by an absolute floor, otherwise a campaign about nothing in
     * the catalog would still crown a 100% winner out of noise. */
    const best = ranked.length ? ranked[0].score : 0;
    if (best < MIN_SPHERE_SIGNAL) return [];

    for (const s of ranked) s.confidence = Math.round(clamp01(s.score / best) * 100);

    /* The floor applies to every sphere, not just the leader. It used to
     * gate the leader alone, so a runner-up matching on one incidental
     * word rode in behind a strong first place: a post flaired "Police
     * State" pulled in the racial justice sphere on the word "police",
     * and from there every racial justice community in the catalog. */
    const floor = opts.minConfidence == null ? 20 : opts.minConfidence;
    return ranked
      .filter((s) => s.score >= MIN_SPHERE_SIGNAL && s.confidence >= floor)
      .slice(0, opts.limit || 8);
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

  /* How far the campaign itself trusts a sphere, 0..1. A sphere the user
   * pinned by hand carries no computed confidence and is taken at face
   * value. */
  function sphereWeight(sphere) {
    if (!sphere) return 0;
    if (sphere.confidence == null) return 1;
    return clamp01(sphere.confidence / 100);
  }

  /* The campaign's confidence in whichever of a sub's catalog spheres it
   * matches best. Catalog keys carry a `demo:` / `state:` prefix that the
   * sphere profiles do not. */
  function catalogAffinityOf(catalogSpheres, spheres) {
    let best = 0;
    for (const raw of catalogSpheres || []) {
      const key = String(raw).replace(/^(state|demo):/, "");
      for (const sphere of spheres || []) {
        if (sphere.key !== key) continue;
        const w = sphereWeight(sphere);
        if (w > best) best = w;
      }
    }
    return best;
  }

  /* Score one candidate. `ctx` carries the campaign vector, the ranked
   * spheres, the idf table, and the per-name hit tallies from search and
   * post mining. */
  Discovery.scoreCandidate = function (record, ctx) {
    const vec = record.vector || SubIndex.vectorFor(record);

    const themeSim = SubIndex.cosine(ctx.vector, vec, ctx.idf);

    /* Cosine cannot tell a shared vocabulary from a shared word, and on
     * documents this short one word is enough to look like a match:
     * r/PersonOfInterest, a subreddit about a television series, scored
     * against a post on a person being arrested because both said
     * "person". Credit is scaled by how many terms carry the similarity,
     * so a match resting on a single term keeps very little of it. */
    const shape = SubIndex.overlapProfile(ctx.vector, vec, ctx.idf);
    const breadth = clamp01((shape.count - 1) / 2);
    const dilution = 1 - 0.7 * shape.topShare * (1 - breadth);
    const theme = rescale(themeSim) * dilution;

    /* Sphere fit is a claim about the *candidate* — "this is a racial
     * justice community" — and says nothing about whether the campaign
     * is a racial justice campaign. Scoring it raw meant a sphere the
     * campaign barely matched handed full marks to every one of its
     * members, so the fit is discounted by the campaign's own confidence
     * in that sphere, and the sphere offered as the explanation is the
     * one that survives that discount. */
    let bestSphere = null;
    let sphereFit = 0;
    let sphereScore = 0;
    for (const sphere of ctx.spheres || []) {
      const fit = rescale(SubIndex.cosine(sphere.vector || sphere._vector || {}, vec, ctx.idf));
      const weighted = fit * sphereWeight(sphere);
      if (weighted > sphereScore) {
        sphereScore = weighted;
        sphereFit = fit;
        bestSphere = sphere;
      }
    }
    const sphereConfidence = sphereWeight(bestSphere);

    /* A sub can be strongly on-theme without being civic (a news
     * aggregator) or civic without being on-theme (a generic politics
     * sub) — both matter, differently. */
    const civic = rescale(SubIndex.cosine(civicVector, vec, ctx.idf));

    const popularity = clamp01(Math.log10((record.subscribers || 0) + 10) / 6);
    const subProfile = ctx.subProfiles && ctx.subProfiles[record.key];
    const engagement = engagementScore(record, subProfile);

    /* How many of the independent search angles turned this sub up. It
     * carries a little more weight than it used to: post mining was the
     * other corroborating signal, and the archive cannot search Reddit
     * site-wide, so this is now the only evidence that a community
     * answers to the campaign's vocabulary from more than one direction. */
    const queryHits = (ctx.queryHits && ctx.queryHits[record.key]) || 0;
    const queryBoost = clamp01(queryHits / 4);

    /* Being in the curated catalog shows a sub is a real organising
     * space; it does not show it is *this* campaign's organising space.
     * A flat boost let hand-listed communities ride into unrelated
     * campaigns on curation alone, so only a small part of it is
     * unconditional and the rest tracks how well the campaign matches
     * the sphere the sub was catalogued under. */
    const catalogSpheres = window.Seeds ? Seeds.spheresOf(record.display_name) : [];
    const catalogAffinity = catalogSpheres.length ? catalogAffinityOf(catalogSpheres, ctx.spheres) : 0;
    const catalogBoost = catalogSpheres.length ? 0.03 + 0.11 * catalogAffinity : 0;

    const offtopic = offtopicHits(record);
    const offtopicPenalty = clamp01(offtopic / 3);

    /* A sub with 8 million subscribers matches almost any vocabulary by
     * sheer surface area. Discount its popularity contribution unless it
     * is genuinely on-theme. */
    const megaGeneric = (record.subscribers || 0) > 3000000 && theme < 0.35;
    const popularityEffective = megaGeneric ? popularity * 0.2 : popularity;

    let raw =
      0.38 * theme +
      0.20 * sphereScore +
      0.10 * civic +
      0.09 * engagement +
      0.07 * popularityEffective +
      0.06 * queryBoost +
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
        overlapCount: shape.count,
        sphere: sphereScore,
        sphereFit: sphereFit,
        sphereConfidence: sphereConfidence,
        sphereKey: bestSphere ? bestSphere.key : null,
        sphereLabel: bestSphere ? bestSphere.label : null,
        civic: civic,
        engagement: engagement,
        popularity: popularity,
        queryHits: queryHits,
        offtopic: offtopic,
        catalog: catalogSpheres,
        catalogAffinity: catalogAffinity,
        megaGeneric: megaGeneric,
      },
      overlapTerms: overlap,
      reasons: buildReasons(record, overlap, {
        theme: theme, sphere: sphereScore, civic: civic,
        sphereFit: sphereFit, sphereConfidence: sphereConfidence,
        bestSphere: bestSphere, queryHits: queryHits,
        catalogSpheres: catalogSpheres, catalogAffinity: catalogAffinity,
        offtopic: offtopic,
        megaGeneric: megaGeneric, engagement: engagement,
        subject: ctx.subject,
      }),
    };
  };

  /* Reasons name the actual overlapping vocabulary rather than restating
   * the score, so a user can judge whether the match is real. */
  function buildReasons(record, overlap, s) {
    const esc = window.Util ? Util.escapeHtml : (x) => String(x);
    const subject = esc(s.subject || "campaign");
    const out = [];

    if (overlap.length) {
      /* Comma-separated: the overlap list mixes single words and
         bigrams, and space-separated they ran together into phrases
         nobody wrote ("healthcare policy policy single single payer"). */
      const words = overlap.slice(0, 5).map((t) => `<code>${esc(t.term)}</code>`).join(", ");
      out.push(overlap.length === 1
        ? `Shares only the term ${words} with your ${subject} — thin evidence on its own`
        : `Shares vocabulary ${words} with your ${subject}`);
    } else {
      out.push("No direct vocabulary overlap — surfaced by sphere or activity signals");
    }

    /* Both halves of the sphere claim, because they answer different
     * questions. The fit says how squarely the sub sits in the sphere;
     * the confidence says whether the campaign belongs there at all. */
    if (s.bestSphere && s.sphereFit > 0.25) {
      const fit = Math.round(s.sphereFit * 100);
      const conf = Math.round(s.sphereConfidence * 100);
      out.push(s.sphereConfidence >= 0.6
        ? `Reads as a <strong>${esc(s.bestSphere.label)}</strong> community (${fit}% fit)`
        : `Reads as a <strong>${esc(s.bestSphere.label)}</strong> community (${fit}% fit), a sphere your ${subject} matches only weakly (${conf}%)`);
    }
    if (s.catalogSpheres && s.catalogSpheres.length) {
      const labels = s.catalogSpheres
        .slice(0, 2)
        .map((k) => esc(Seeds.labelOf(k.replace(/^(state|demo):/, ""))))
        .join(", ");
      out.push(s.catalogAffinity >= 0.5
        ? `In the curated catalog under ${labels}`
        : `In the curated catalog under ${labels}, which your ${subject} does not clearly match`);
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
      /* Curated membership earns a free pass, but only for the sphere it
       * was curated under. Passing every catalog member unconditionally
       * is how a racial justice community survived Relevant mode on a
       * campaign about a data centre: hand-listed somewhere was treated
       * as hand-listed here. */
      if (s.catalog && s.catalog.length && s.catalogAffinity >= 0.5) { kept.push(c); continue; }

      if (s.offtopic >= 2 && s.theme < 0.3) { dropped.offtopic++; continue; }
      if (s.megaGeneric && s.sphere < 0.3) { dropped.mega++; continue; }

      /* Sphere fit alone only carries a sub when the campaign clearly
       * belongs to that sphere. Otherwise a community can be a perfect
       * example of an issue the campaign is not about, and score well
       * for it. */
      const strongEnough =
        s.theme >= 0.28 ||
        (s.sphere >= 0.3 && s.sphereConfidence >= 0.5) ||
        (s.theme >= 0.15 && s.sphere >= 0.18) ||
        s.queryHits >= 3;
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

    /* ---- Phase 2: seed from the spheres that scored ---- */
    const seedNames = [];
    for (const sphere of activeSpheres) {
      for (const name of sphere.subs || []) seedNames.push(name);
    }

    /* ---- Phase 3: make sure every candidate has real metadata ----
     * This is the change that makes description matching trustworthy.
     * Previously most candidates were scored on whatever the search
     * endpoint returned and only a couple of dozen ever got about.json;
     * now every name in play is resolved through the index, which caches
     * for 30 days so a second run is nearly free. */
    const allNames = Array.from(new Set(
      Array.from(found.keys()).concat(seedNames.map((n) => String(n)))
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

    /* ---- Phase 4: score ---- */
    report(88, "Scoring candidates…");
    /* Dedupe on the resolved record, not on the name that led to it.
     * allNames holds search results keyed in lowercase alongside
     * catalog entries in their display casing, so r/TenantUnion and
     * r/tenantunion survive the Set as two strings and resolve to one
     * record — which is how the same community used to be recommended
     * twice, at identical scores, in the same list. */
    const byKey = new Map();
    for (const name of allNames) {
      const record = SubIndex.get(name);
      if (!record) continue;
      if (record.over18) continue;
      if ((record.subscribers || 0) < (opts.minSubs == null ? 25 : opts.minSubs)) continue;
      if (!byKey.has(record.key)) byKey.set(record.key, record);
    }
    const records = Array.from(byKey.values());

    const idf = SubIndex.buildIdf(records.map((r) => r.vector).concat([vector]));
    const ctx = {
      vector: vector,
      idf: idf,
      spheres: activeSpheres,
      queryHits: queryHits,
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

    /* 4. What the sub actually posts about, which is regularly not what
     *    its sidebar says it is about. Read its own recent top posts and
     *    search for communities named after that vocabulary. This used
     *    to look for co-posting — the same story appearing in several
     *    subs at once — but that needs a site-wide post search, and the
     *    archive scopes free-text queries to one subreddit. Searching on
     *    post vocabulary instead keeps the distinction that made step 4
     *    worth having: step 3 asks who describes themselves like this
     *    sub, step 4 asks who talks about what it talks about. */
    if (window.Reddit && opts.live !== false && opts.mine !== false) {
      try {
        const posts = await Reddit.fetchSubredditListing(target.display_name, {
          listing: "top", limit: 25, t: "month",
        }) || [];
        const titleTerms = {};
        for (const p of posts.slice(0, 15)) {
          for (const t of SubIndex.tokenize(p.title || "")) titleTerms[t] = (titleTerms[t] || 0) + 1;
        }
        /* Only terms the sub returns to repeatedly — a term used once is
         * one story, not a subject the community is organised around. */
        const topics = Object.entries(titleTerms)
          .filter(([, n]) => n >= 2)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([t]) => t);
        for (const topic of topics) {
          const results = await Reddit.searchSubreddits(topic, { limit: 10 });
          for (const raw of results) {
            const record = SubIndex.put(raw, { partial: true });
            if (record && record.key !== key) note(record.display_name, "topics", 0.25);
          }
        }
      } catch (err) {
        console.warn("[discovery] similar topics:", err && err.message);
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

    /* The curated catalog answers issue queries without a single
     * request. That matters more than it sounds. The archive matches
     * subreddit names by prefix rather than doing Reddit's fuzzy
     * relevance search, so a query like "tenant rights" finds
     * r/TenantRights and misses r/Renters entirely; and when the
     * archive is unreachable the live sources below return nothing at
     * all, and a search box that can only fail is worse than no search
     * box. Ranking the spheres against the query and offering their
     * members covers both cases. */
    const queryVector = Discovery.textVector(q);
    /* States are in scope here, unlike campaign discovery: someone
     * typing "texas" into a search box wants the Texas communities, and
     * offline the catalog is the only place they exist. */
    const ranked = Discovery.rankSpheres(queryVector, { minConfidence: 0, limit: 100, includeStates: true });
    const sphereConfidence = new Map(ranked.map((s) => [s.key, s.confidence / 100]));

    for (const sphere of ranked.slice(0, 2)) {
      if (sphere.confidence < 45) break;
      for (const name of (sphere.subs || []).slice(0, 8)) {
        add(SubIndex.get(name) || SubIndex.makeRecord({ display_name: name }, { partial: true }), "catalog");
      }
    }

    if (window.Reddit && opts.live !== false) {
      const tasks = [
        Reddit.autocompleteSubreddits(q, { limit: 10 }).catch(() => []),
        Reddit.searchSubreddits(q, { limit: 20 }).catch(() => []),
      ];
      const [auto, full] = await Promise.all(tasks);
      for (const raw of auto) add(SubIndex.put(raw, { partial: true }), "autocomplete");
      for (const raw of full) add(SubIndex.put(raw, { partial: true }), "search");
    }

    const entries = Array.from(byKey.values());
    const idf = SubIndex.buildIdf(entries.map((e) => e.record.vector));

    const results = entries.map((entry) => {
      const record = entry.record;
      const exact = record.key === q.toLowerCase().replace(/^\/?r\//, "");
      const prefix = record.key.startsWith(q.toLowerCase().replace(/^\/?r\//, ""));
      const relevance = SubIndex.cosine(queryVector, record.vector, idf);
      const popularity = clamp01(Math.log10((record.subscribers || 0) + 10) / 6);
      const spheres = window.Seeds ? Seeds.spheresOf(record.display_name) : [];

      /* Which issue a human filed this community under, weighted by how
       * well that issue matches the query. This is what keeps "tenant
       * rights" from leading with r/VotingRights: both share the word
       * "rights", but Housing scores 100% against the query and Voting
       * scores 12%, so the tenancy subs pull far ahead. */
      let affinity = 0;
      for (const key of spheres) {
        /* spheresOf namespaces states and audiences; the profiles are
         * keyed bare. */
        affinity = Math.max(affinity, sphereConfidence.get(key.replace(/^(state|demo):/, "")) || 0);
      }

      return {
        record: record,
        name: record.display_name,
        exact: exact,
        sources: entry.sources,
        spheres: spheres,
        rank: (exact ? 2 : 0)
          + (prefix ? 0.6 : 0)
          + affinity * 0.9
          + rescale(relevance)
          + popularity * 0.5,
      };
    });

    results.sort((a, b) => b.rank - a.rank);
    return results.slice(0, opts.limit || 25);
  };

  /* ==================================================================
   * ONE POST → ITS SPHERES → THE COMMUNITIES THEY IMPLY
   * ------------------------------------------------------------------
   * Discovery.run needs a campaign. But the moment a user is looking
   * at a single interesting post, the same question already applies:
   * what is this about, and where else would it land? This is the
   * cheap single-post version — just the catalog, the local index and
   * a bounded about.json fill.
   *
   * It reports twice. The first pass scores whatever is already
   * cached, so the panel paints immediately; the second pass fills in
   * real descriptions and re-scores. Waiting on the network before
   * showing anything made the affordance feel broken when the archive
   * was slow.
   * ================================================================== */

  /* The term vector for one post. Title carries the message, flair
   * carries the framing the community itself applied, and the body is
   * folded in at low weight and truncated — a long self-post otherwise
   * swamps its own headline. */
  Discovery.postVector = function (post) {
    const vec = {};
    if (!post) return vec;
    SubIndex.addText(vec, post.title || "", 3);
    if (post.flair) SubIndex.addText(vec, post.flair, 2);
    if (post.selftext) SubIndex.addText(vec, String(post.selftext).slice(0, 1500), 0.8);
    if (post.subreddit) {
      SubIndex.addText(vec, post.subreddit, 1.5);
      const record = SubIndex.get(post.subreddit);
      if (record) {
        SubIndex.addText(vec, record.title || "", 1);
        SubIndex.addText(vec, record.public_description || "", 0.8);
      }
    }
    return vec;
  };

  /*   opts.limit        communities to return (default 12)
   *   opts.exclude      names to mark as already loaded
   *   opts.live         false to stay entirely offline
   *   opts.aboutBudget  how many about.json reads the live pass may do
   *   opts.onPartial    called with the offline result before the fill
   */
  Discovery.forPost = async function (post, opts) {
    opts = opts || {};
    await SubIndex.load();

    const vector = Discovery.postVector(post);
    if (!Object.keys(vector).length) {
      throw new Error("This post has no readable text to match communities against.");
    }

    const home = String(post.subreddit || "").toLowerCase();
    const excludeSet = new Set([home].concat((opts.exclude || []).map((s) => String(s).toLowerCase())));
    excludeSet.delete("");

    /* Candidate names come from three offline sources: the spheres the
     * post text matches, the spheres the home sub is catalogued under
     * (a labour post in a labour sub should surface labour siblings
     * even when the title is too short to rank a sphere), and the
     * nearest descriptions in whatever the index has already cached. */
    function gatherNames(spheres) {
      const names = new Map(); /* lowercase key -> display name */
      const via = new Map();   /* lowercase key -> sphere label */

      function add(name, sphereLabel) {
        const key = String(name || "").toLowerCase();
        if (!key || excludeSet.has(key)) return;
        if (!names.has(key)) names.set(key, name);
        if (sphereLabel && !via.has(key)) via.set(key, sphereLabel);
      }

      for (const sphere of spheres) {
        for (const name of sphere.subs || []) add(name, sphere.label);
      }
      if (window.Seeds && post.subreddit) {
        for (const key of Seeds.spheresOf(post.subreddit) || []) {
          const label = Seeds.labelOf(String(key).replace(/^(state|demo):/, ""));
          for (const name of Seeds.expand([key]) || []) add(name, label);
        }
      }
      for (const hit of SubIndex.nearest(vector, { exclude: [home], limit: 20 })) {
        add(hit.record.display_name, null);
      }
      return { names: names, via: via };
    }

    function build(spheres) {
      const gathered = gatherNames(spheres);
      const sphereByKey = new Map(Discovery.sphereProfiles().map((s) => [s.key, s]));
      const withVectors = spheres.map((s) =>
        Object.assign({}, s, { vector: (sphereByKey.get(s.key) || {}).vector }));

      /* Catalog members we have never fetched still deserve a row. They
       * were curated for this issue by hand, and telling the user
       * "nothing matched" because about.json has not been read yet
       * would be the index's problem presented as an answer. They get
       * a name-only record and are exempt from the subscriber floor,
       * since we do not know their size to check it against. */
      const records = [];
      const stubs = new Set();
      for (const [key, display] of gathered.names.entries()) {
        const record = SubIndex.get(key);
        if (record) {
          if (record.over18) continue;
          if ((record.subscribers || 0) < (opts.minSubs == null ? 25 : opts.minSubs)) continue;
          records.push(record);
          continue;
        }
        if (!gathered.via.has(key)) continue;
        const stub = SubIndex.makeRecord({ display_name: display }, { partial: true });
        if (!stub) continue;
        stubs.add(key);
        records.push(stub);
      }

      const idf = SubIndex.buildIdf(records.map((r) => r.vector).concat([vector]));
      const ctx = {
        vector: vector,
        idf: idf,
        spheres: withVectors,
        subProfiles: (window.AppState && AppState.subProfiles) || {},
        subject: "post",
      };

      const scored = records.map((r) => {
        const c = Discovery.scoreCandidate(r, ctx);
        c.viaSphere = gathered.via.get(r.key) || (c.signals.sphereLabel || null);
        c.loaded = !!(window.AppState && AppState.hasSub && AppState.hasSub(r.display_name));
        c.stub = stubs.has(r.key);
        /* A name-only match is a weaker claim than one backed by the
         * community's own description, so it never outranks one. */
        if (c.stub) {
          c.composite *= 0.9;
          c.score = Math.round(c.composite * 100);
        }
        return c;
      });
      scored.sort((a, b) => b.composite - a.composite);

      return {
        post: post,
        vector: vector,
        terms: Discovery.topTerms(vector, 8),
        spheres: spheres,
        home: SubIndex.get(home) || null,
        communities: scored.slice(0, opts.limit || 12),
        pool: gathered.names.size,
        resolved: records.length - stubs.size,
      };
    }

    const minConfidence = opts.minConfidence == null ? 40 : opts.minConfidence;
    let spheres = Discovery.rankSpheres(vector, {
      limit: opts.sphereLimit || 4,
      minConfidence: minConfidence,
    });

    const partial = build(spheres);
    if (typeof opts.onPartial === "function") {
      try { opts.onPartial(partial); } catch (err) { console.warn("[forPost] onPartial:", err && err.message); }
    }
    if (opts.live === false) return partial;

    /* Live pass: resolve descriptions for the shortlist so scoring is
     * based on what the communities actually say about themselves.
     *
     * Bounded by a deadline rather than run to completion. If the
     * archive is slow or unreachable, SubIndex.ensure takes as long as
     * its slowest timeout, and the user is left staring at a panel that
     * already had a usable offline answer. Whatever landed inside the
     * deadline is in the index by then, so the re-score picks it up
     * either way. */
    const shortlist = Array.from(gatherNames(spheres).names.values());
    if (shortlist.length) {
      const fill = SubIndex.ensure(shortlist, {
        limit: opts.aboutBudget == null ? 40 : opts.aboutBudget,
        concurrency: 4,
        onProgress: opts.onProgress,
      }).catch((err) => console.warn("[forPost] description fill:", err && err.message));

      const budget = opts.liveTimeout == null ? 12000 : opts.liveTimeout;
      let timer;
      await Promise.race([fill, new Promise((resolve) => { timer = setTimeout(resolve, budget); })]);
      clearTimeout(timer);
    }

    /* Descriptions sharpen the sphere vectors, so the ranking is worth
     * redoing rather than reusing the offline guess. */
    Discovery.invalidateSpheres();
    spheres = Discovery.rankSpheres(vector, {
      limit: opts.sphereLimit || 4,
      minConfidence: minConfidence,
    });

    return build(spheres);
  };

  window.Discovery = Discovery;
})();
