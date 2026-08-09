/* ======================================================================
 * NEXT MOVE — one post, ranked places to put it
 * ----------------------------------------------------------------------
 * Everything needed to answer "where should this go next" already
 * existed, in two halves that had never been introduced.
 *
 * Discovery knows what a post is about and which communities talk that
 * way. Timing knows when each community's posts do well and how much
 * better than its own average. Separately, each half gives half an
 * answer: a list of subreddits with no hour attached, or a list of
 * hours with no post attached.
 *
 * This module joins them and puts one number in front:
 *
 *     projected / baseline
 *
 * Both sides come from the same estimator, so the ratio means
 * something. `baseline` is what a typical post does in the community
 * this post is in now, across all hours. `projected` is what a typical
 * post does in the candidate community, in its best window. So the
 * ratio is exactly "a typical post there, at the right time, against a
 * typical post where you are now" — and it factors cleanly:
 *
 *     projected     candidate's typical      its peak window
 *     ---------  =  -------------------  ×  ------------------
 *     baseline       home's typical          its own average
 *
 *          the community difference      the timing difference
 *
 * which is why the card can show both halves rather than one opaque
 * score. Two caveats, both surfaced in the UI rather than buried:
 *
 *   - It is a claim about a typical post, not about this post. A post
 *     that went viral where it is will not repeat that by moving.
 *   - Communities with nothing loaded have no timing at all. They are
 *     kept in a separate bucket and never ranked against measured
 *     ones, because an unmeasured community is not a better bet, it
 *     is an unknown one.
 *
 * The typicals are the log-space fits from js/timing.js, not means, so
 * a single breakout post cannot talk a community up.
 * ====================================================================== */

(function () {
  "use strict";

  const NextMove = {};

  /* Communities whose peak beats home by this much are already at the
     top of the gain scale; past it the ranking should be decided by
     how well the post fits rather than by ever-larger multiples. */
  const GAIN_CEILING = 5;

  /* How much of the ranking each signal carries. The post's fit leads
     because a big audience for the wrong thing is not an opportunity,
     and timing evidence trails because it grades the estimate rather
     than the prize. */
  const W_MATCH = 0.45;
  const W_GAIN = 0.35;
  const W_TIMING = 0.20;

  /* Below this many posts a community's timing fit is real but thin,
     and the ranking discounts it rather than pretending otherwise.
     Matches Timing's own "solid" threshold. */
  const SOLID = 12;

  const EVIDENCE = { strong: 1, likely: 0.7, weak: 0.4, none: 0.15 };

  /* The relevance gate. See assemble() for why it is both. */
  const RELEVANT_SHARE = 0.45;
  const MIN_MEASURED_FIT = 25;
  const MIN_FIT = 15;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function positive(n) {
    return typeof n === "number" && isFinite(n) && n > 0 ? n : 0;
  }

  /* ------------------------------------------------------------------
   * BASELINE — what the comparison is against
   * ------------------------------------------------------------------ */

  /* Preference order is about keeping both sides of the ratio on the
     same footing. The home community's fitted typical is the like-for
     -like partner of a candidate's fitted typical; a raw median is the
     next best thing; the whole loaded pool is the last resort, for a
     pasted link from a community nobody here has loaded.
     
     Deliberately NOT the post's own score. Comparing one post against
     communities' typicals would tell every author of a breakout post
     that nowhere is worth trying, and every author of a flop that
     everywhere is — which is a fact about their last post, not about
     where this one belongs. The post's own score is reported beside
     the ratio instead, as context. */
  NextMove.baselineFor = function (post, ctx) {
    ctx = ctx || {};
    const home = String((post && post.subreddit) || "").toLowerCase();
    const rowFor = ctx.rowFor || (() => null);

    if (home) {
      const row = rowFor(home);
      const fitted = row && row.fit && positive(row.fit.baselineScore);
      if (fitted) {
        return {
          score: fitted,
          source: "home-fit",
          sub: row.subreddit || home,
          label: `a typical post in r/${row.subreddit || home}`,
        };
      }
      const posts = (window.AppState && AppState.postsForSub(home)) || [];
      if (posts.length >= 3) {
        const med = Util.median(posts.map((p) => p.score || 0));
        if (positive(med)) {
          return {
            score: med,
            source: "home-median",
            sub: post.subreddit,
            label: `a typical post in r/${post.subreddit}`,
          };
        }
      }
    }

    const all = (window.AppState && AppState.posts) || [];
    const med = Util.median(all.map((p) => p.score || 0));
    if (positive(med)) {
      return {
        score: med,
        source: "pool",
        sub: null,
        label: "a typical post across your loaded communities",
      };
    }
    return { score: 0, source: "none", sub: null, label: "" };
  };

  /* ------------------------------------------------------------------
   * ONE CANDIDATE
   * ------------------------------------------------------------------ */

  /* Fold one discovery candidate together with whatever timing exists
     for it. Returns a row whose numbers are all optional: a community
     with no loaded posts still gets a match and a reason, it just has
     no hour and no projection. */
  function makeMove(cand, ctx) {
    const name = cand.name;
    const key = String(name || "").toLowerCase();
    const row = ctx.rowFor(key);
    const base = ctx.baseline.score;

    /* Community rules run before scoring. A room that will remove this
       post is not an opportunity, however well its subject matches —
       and burying that fact under a high match number is how people
       learn the hard way. */
    const rules = (window.Rules && ctx.post)
      ? Rules.evaluate(ctx.post, key, { posts: ctx.posts })
      : { ok: true, hard: false, reasons: [], kind: null, rule: null, duplicate: null };

    const move = {
      key: key,
      name: name,
      fit: cand.score,
      composite: cand.composite,
      loaded: !!cand.loaded,
      stub: !!cand.stub,
      viaSphere: cand.viaSphere || null,
      reasons: cand.reasons || [],
      overlapTerms: (cand.overlapTerms || []).map((t) => t.term || t),
      record: cand.record || null,
      /* The four parts the match score is made of. Discovery has always
         computed these; only the campaign's own Discover panel ever drew
         them, so the same recommendation showed its workings in one tab
         and asserted a bare number in another. Carrying them here lets
         one card answer both "where" and "why". */
      signals: cand.signals || null,
      row: row || null,
      measured: false,
      graded: false,
      signal: "none",
      lift: 0,
      when: null,
      rules: rules,
      blocked: !!(rules && rules.hard && !rules.ok),
      ruleReasons: (rules && rules.reasons) || [],
    };

    if (move.blocked) {
      move.posts = row ? row.count : 0;
      move.verdict = "blocked";
      move.score = -1;
      return move;
    }

    /* Nothing loaded here, or too few posts to fit. Matched, not
       measured — a distinct state from "measured and unpromising",
       and the card keeps them apart. */
    if (!row || !row.fit) {
      move.posts = row ? row.count : 0;
      move.verdict = "unmeasured";
      move.score = W_MATCH * (cand.composite || 0);
      return move;
    }

    const fit = row.fit;
    move.measured = true;
    move.posts = row.count;
    move.signal = row.signal || "none";
    move.baseline = base;
    move.reachRatio = base > 0 ? positive(fit.baselineScore) / base : 0;

    /* A signal of "none" is Timing declining to name an hour: the peak
       it found is not distinguishable from the community posting at
       random times. Its raw lift can still look big — 66% off a flat
       day is easy with twenty posts — so quoting the peak here would
       launder exactly the noise the timing model just refused to sell.
       These communities keep their reach comparison and lose their
       clock, which is the honest half of the answer. */
    const graded = move.signal !== "none" && row.slot != null;
    move.graded = graded;

    if (graded) {
      move.lift = row.lift || 0;
      move.liftLow = row.liftLow;
      move.slotLabel = row.slotLabel;
      move.window = row.window;
      move.when = row.next || Timing.nextOccurrence(row);
      move.dowName = row.dowName || null;
      move.timingRatio = 1 + (row.lift || 0) / 100;
      move.projected = positive(fit.typicalScore);
      if (typeof row.liftLow === "number" && isFinite(row.liftLow)) {
        /* The conservative end: the community difference at face value,
           the timing gain only as far as its interval will support.
           Mirrors the "at least +20%" already used on the timing rows,
           so a wide interval cannot read as a promise. */
        move.ratioLow = move.reachRatio * (1 + Math.max(0, row.liftLow) / 100);
      }
    } else {
      move.timingRatio = 1;
      move.projected = positive(fit.baselineScore);
      move.ratioLow = move.reachRatio;
    }

    move.ratio = base > 0 && move.projected ? move.projected / base : 0;
    move.changePct = move.ratio ? (move.ratio - 1) * 100 : 0;

    /* --- ranking --- */
    const matchPart = clamp(cand.composite || 0, 0, 1);
    /* Log-scaled and centred, so parity scores a half and the ceiling
       scores full marks. A community that is typically worse than home
       can still be worth posting in, so this floors rather than
       disqualifies. */
    const gainPart = move.ratio > 0
      ? clamp(Math.log(move.ratio) / Math.log(GAIN_CEILING) * 0.5 + 0.5, 0, 1)
      : 0.5;
    const timingPart = EVIDENCE[move.signal] == null ? 0.15 : EVIDENCE[move.signal];

    const sample = clamp(row.count / SOLID, 0.5, 1);
    move.score = (W_MATCH * matchPart + W_GAIN * gainPart + W_TIMING * timingPart)
      * (0.7 + 0.3 * sample);

    move.verdict = verdictFor(move);
    return move;
  }

  /* Plain words for the combined read. The timing badge already grades
     the hour on its own terms; this grades the whole suggestion, which
     is a different question — a community can have an immaculate peak
     and still be the wrong room. */
  /* Forty is where the observed distribution turns over: communities
     that genuinely share a subject with a post score 50–70, catalog
     siblings that only share a sphere score 15–30. */
  const GOOD_FIT = 40;

  function verdictFor(move) {
    const held = {
      fit: move.fit >= GOOD_FIT,
      timing: move.graded && (move.signal === "strong" || move.signal === "likely"),
      gain: move.ratio >= 1.15,
    };
    move.held = held;
    const n = (held.fit ? 1 : 0) + (held.timing ? 1 : 0) + (held.gain ? 1 : 0);
    return n === 3 ? "strong" : n === 2 ? "fair" : "thin";
  }

  /* Which of the three tests a suggestion passed, as a sentence. The
     tier on its own is ambiguous in a way that matters: the best-
     matching community for a post and a community with a good clock
     and nothing else can land in the same band for opposite reasons,
     and "worth a try" would be all the user ever heard about it. */
  NextMove.heldLabel = function (move) {
    if (!move || !move.held) return "";
    return [
      move.held.fit ? "Reads like this post" : "Only a loose match on subject",
      move.held.timing
        ? "its best hour holds up when tested"
        : move.graded ? "its best hour is shaky" : "no best hour stands out there",
      move.held.gain
        ? "typically beats where you are now"
        : "typically does no better than where you are now",
    ].join(" · ") + ".";
  };

  NextMove.VERDICTS = {
    strong: {
      label: "strong case",
      tone: "good",
      why: "reads like this community, its best window is well evidenced, and a typical post there beats where you are now",
    },
    fair: {
      label: "worth a try",
      tone: "info",
      why: "two of the three hold up — the fit, the timing evidence or the gain — but not all three",
    },
    thin: {
      label: "long shot",
      tone: "warn",
      why: "either the match is loose or the timing is barely distinguishable from chance",
    },
    blocked: {
      label: "against the rules",
      tone: "bad",
      why: "this community's posting rules reject this kind of post",
    },
    unmeasured: {
      label: "not measured",
      tone: "",
      why: "the post reads like this community, but nothing is loaded from it, so there is no best hour to give",
    },
  };

  /* ------------------------------------------------------------------
   * THE RANKING
   * ------------------------------------------------------------------ */

  /*   opts.timing     an existing Timing.model, to avoid refitting
   *   opts.limit      measured moves to return (default 8)
   *   opts.related    a Discovery.forPost result to reuse
   *   opts.exclude    subs to leave out — where the content already is
   *   opts.live       false to stay offline (demo mode, tests)
   *   opts.onPartial  called with an offline ranking before the fill
   */
  NextMove.rank = async function (post, opts) {
    opts = opts || {};
    if (!post) throw new Error("No post to place.");

    /* One index over whatever timing the caller already computed, plus
       a lazy per-sub fit for candidates the dashboard's model never
       covered. The dashboard model only spans loaded subs inside the
       current filter, and a candidate can be loaded but filtered out. */
    const byKey = new Map();
    for (const r of (opts.timing && opts.timing.rows) || []) byKey.set(r.key, r);
    const computed = new Map();

    function rowFor(key) {
      if (byKey.has(key)) return byKey.get(key);
      if (computed.has(key)) return computed.get(key);
      const posts = (window.AppState && AppState.postsForSub(key)) || [];
      const row = posts.length >= 4
        ? Timing.row(key, posts[0].subreddit || key, posts)
        : null;
      computed.set(key, row);
      return row;
    }

    const baseline = NextMove.baselineFor(post, { rowFor: rowFor });
    const exclude = new Set((opts.exclude || []).map((s) => String(s).toLowerCase()));
    const postKind = window.Rules ? Rules.classify(post) : null;

    function assemble(related) {
      const ctx = {
        rowFor: rowFor,
        baseline: baseline,
        post: post,
        posts: (window.AppState && AppState.posts) || [],
      };
      const all = (related.communities || [])
        .filter((c) => c && c.name && !exclude.has(String(c.name).toLowerCase()))
        .map((c) => makeMove(c, ctx));

      /* Communities whose rules reject this post kind. Kept as a
         separate list so the card can say "r/politics takes articles,
         this is a text post" rather than silently ranking rooms that
         would remove it. Soft failures (ok:false, hard:false) stay in
         the main pool with a warning — they are uncertain, not banned. */
      const blocked = all.filter((m) => m.blocked)
        .sort((a, b) => b.fit - a.fit);

      /* Relevance is a gate before it is a weight.
       *
       * Weighting it was not enough. Every loaded community is a
       * candidate now, and a big one with a good clock could outscore
       * the community the post is actually about on reach alone —
       * r/MedicareForAll came out top for a post about solar
       * generation costs, on a match of 23 out of 100, because it had
       * the best hour and the biggest typical post. A large audience
       * for the wrong subject is not an opportunity, and no amount of
       * timing evidence makes it one.
       *
       * The bar is partly relative, because match scores are only
       * comparable within one post: a post whose subject the catalog
       * covers well scores its best community at 80, one written in
       * unusual terms tops out at 30, and a share of the best is what
       * separates the subject from its neighbours in both.
       *
       * It is partly absolute because a relative bar alone fails in
       * the case that matters most. A post about ballot-rejection law
       * scored every loaded community between 15 and 20 — a smooth
       * decay with no real match anywhere in it — and half of a weak
       * best is still weak, so the gate let all eight through and the
       * card ranked eight coin flips. For a community whose own
       * description has been read, a match in the teens means the
       * shared words are incidental. When nothing clears the absolute
       * bar the honest answer is that nothing loaded is about this,
       * which is what the card then says. */
      const eligible = all.filter((m) => !m.blocked);
      const bestFit = eligible.reduce((m, c) => Math.max(m, c.fit || 0), 0);
      const floor = Math.max(MIN_MEASURED_FIT, RELEVANT_SHARE * bestFit);

      const measured = eligible.filter((m) => m.measured && m.fit >= floor)
        .sort((a, b) => b.score - a.score);
      /* A looser bar for communities with nothing loaded. They are not
       * competing with anything — they are a shortlist of what to load
       * next — so the cost of an extra name there is a scroll, not a
       * bad recommendation. */
      const unmeasured = eligible.filter((m) => !m.measured && m.fit >= MIN_FIT)
        .sort((a, b) => b.fit - a.fit);

      /* Among measured moves, the lead is the one to act on soonest
         rather than the highest scoring — a marginally better room
         eighteen hours out is worse advice than a good one that is
         open now. Only credible moves with an hour to their name get
         to compete on immediacy, so this cannot promote a long shot
         and cannot promote a community with no clock. */
      const strong = measured.filter((m) => m.graded && m.verdict === "strong");
      const pool = strong.length
        ? strong
        : measured.filter((m) => m.graded && m.verdict === "fair");
      let lead = measured[0] || null;
      if (pool.length) {
        lead = pool[0];
        const soon = pool.slice(0, 4).sort((a, b) => waitOf(a) - waitOf(b));
        /* Only if it is genuinely close on merit. */
        if (soon[0] && soon[0].score >= pool[0].score * 0.85) lead = soon[0];
      }

      return {
        post: post,
        kind: postKind,
        baseline: baseline,
        terms: related.terms || [],
        spheres: related.spheres || [],
        home: related.home || null,
        lead: lead,
        moves: measured.slice(0, opts.limit || 8),
        unmeasured: unmeasured.slice(0, opts.unmeasuredLimit || 6),
        blocked: blocked.slice(0, opts.blockedLimit || 6),
        measuredCount: measured.length,
        unmeasuredCount: unmeasured.length,
        blockedCount: blocked.length,
        bestFit: bestFit,
        floor: Math.round(floor),
        /* How many candidates the relevance gate turned away, so the
         * card can say "nothing you have loaded is about this" rather
         * than showing an unexplained gap. */
        rejected: eligible.filter((m) => m.measured && m.fit < floor).length,
        pool: related.pool || 0,
      };
    }

    if (opts.related) return assemble(opts.related);

    /* Discovery reaches outward by design — spheres, the home sub's
       catalogued siblings, nearest descriptions — which finds new
       rooms but walks straight past the ones the user already reads.
       Those are the only communities with posts behind them, so
       they are the only ones that can be given an hour. Naming them
       explicitly is what stops the answer being a list of catalog
       entries nobody has measured. */
    const loaded = ((window.AppState && AppState.knownSubs) || [])
      .filter((s) => AppState.postsForSub(s).length >= 4);

    const related = await Discovery.forPost(post, {
      limit: opts.candidateLimit || 40,
      live: opts.live,
      exclude: opts.exclude,
      include: loaded,
      onPartial: typeof opts.onPartial === "function"
        ? (partial) => {
          try { opts.onPartial(assemble(partial)); } catch (_) {}
        }
        : undefined,
    });
    return assemble(related);
  };

  function waitOf(move) {
    if (!move.when) return Infinity;
    return move.when.open ? 0 : (move.when.inMinutes || 0);
  }
  NextMove.waitOf = waitOf;

  /* ------------------------------------------------------------------
   * WORDS
   * ------------------------------------------------------------------ */

  /* "2.4× the reach" reads better than "+140%" above 2×, and worse
     below it. Both are the same number; pick whichever a person would
     have said. */
  NextMove.gainLabel = function (ratio) {
    if (!ratio || !isFinite(ratio) || ratio <= 0) return "";
    if (ratio >= 1.95) return `${ratio.toFixed(1).replace(/\.0$/, "")}× the reach`;
    if (ratio >= 1.02) return `+${Math.round((ratio - 1) * 100)}% reach`;
    if (ratio <= 0.95) return `${Math.round((1 - ratio) * 100)}% less reach`;
    return "about the same reach";
  };

  NextMove.whenLabel = function (move) {
    if (!move || !move.when) return "";
    if (move.when.open) return `open now, until ${move.when.closesAt}`;
    return `${move.when.label}, ${move.when.inLabel}`;
  };

  window.NextMove = NextMove;
})();
