/* ============================================================
   TIMING — when to post, and the evidence that justifies it
   ------------------------------------------------------------
   The old estimator ranked hours by mean score, shrunk a little
   toward the subreddit's own mean. Two things were wrong with it.

   First, means. Reddit scores are heavy-tailed — a community whose
   typical post takes 200 upvotes will produce a 14,000-upvote post
   every few weeks. In an hour holding three posts, one of those
   drags the hourly mean to 4,700 and no honest hour can compete.
   The estimator was reliably finding the hour that one lucky post
   happened to land in, and presenting it as advice.

   Second, resolution and evidence. "14:00" is a bucket label, not a
   measurement, and it arrived with no indication of whether the
   pattern would survive being asked twice.

   This module answers the same question differently.

     1. Everything is measured in log space. log1p(score) turns a
        multiplicative, heavy-tailed quantity into a roughly normal
        one, so the average stops being a report on the largest
        observation. A 14,000-upvote post now counts 1.6x a
        200-upvote post rather than 70x. Extreme residuals are
        additionally winsorised at three robust deviations, which on
        a log scale only catches genuine anomalies.

     2. Time of day is fitted as a smooth curve, not a histogram. A
        circular Gaussian kernel regression uses every post's exact
        minute and evaluates the fit on a 96-point grid — every
        quarter hour. Sub-hour resolution comes from the shape of the
        curve, not from slicing sparse data into finer bins.

     3. The curve is fitted at several smoothing widths at once and
        scored by a standardised lift, so a sharp two-hour commute
        window and a broad afternoon hump are both findable. Picking
        one width by cross-validation does not work here: prediction
        error is dominated by the nine-tenths of the day where the
        clock tells you nothing, so a narrow window that matters gets
        averaged away.

     4. Every recommendation carries its evidence. A permutation test
        reshuffles the same scores across the same timestamps a few
        hundred times; because the null distribution is itself a
        distribution of maxima over every slot and every width,
        having searched the whole day is already paid for. Alongside
        it: a confidence interval on the lift, the effective sample
        size behind the estimate, and the smoothed upvote ratio at
        that moment.

     5. Reception breaks ties. Where several quarter hours are
        statistically indistinguishable, the recommended minute is
        the best-received one inside the best-performing window.

   All estimates are per subreddit and measured against that
   subreddit's own baseline. Nothing here is pooled across
   communities that keep different hours.
   ============================================================ */
(function () {
  const Timing = {};

  const SLOTS = 96;            /* quarter-hour grid over the day */
  const SLOT_MIN = 15;
  const DAY_MIN = 1440;
  const Z95 = 1.959963985;

  /* Smoothing widths, in hours. Forty-five minutes is the narrowest
     window a subreddit's posting times can resolve before the
     estimate is one post wide; three and a half hours is broad
     enough to catch a whole-afternoon effect without flattening the
     day into its average. */
  const SCALES = [0.75, 1.25, 2, 3.5];

  /* How much of the community's baseline a slot must out-argue.
     Two pseudo-posts is deliberately light — its only job is to stop
     a slot with almost nothing near it from reporting whatever one
     distant post happened to score. */
  const SLOT_PRIOR = 2;

  /* Weights below this are dropped from the kernel. At a
     ten-thousandth of a neighbour the contribution is invisible, and
     the truncation buys a large constant factor in the permutation
     loop, where the same weights are applied a few hundred times. */
  const WEIGHT_FLOOR = 1e-4;
  const CUTOFF_SIGMAS = Math.sqrt(2 * Math.log(1 / WEIGHT_FLOOR));

  const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  Timing.SLOTS = SLOTS;
  Timing.SLOT_MINUTES = SLOT_MIN;
  Timing.DOW_NAMES = DOW_NAMES;
  Timing.DOW_SHORT = DOW_SHORT;

  /* ---------- numeric helpers ---------- */

  function pad2(n) { return String(n).padStart(2, "0"); }

  /* Minutes-of-day rendered as a clock time. */
  Timing.formatSlot = function (minutes) {
    const m = ((Math.round(minutes) % DAY_MIN) + DAY_MIN) % DAY_MIN;
    return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60);
  };

  /* Distance on the 24-hour circle, in minutes. 23:50 and 00:10 are
     twenty minutes apart, not twenty-three hours and forty. */
  function circMin(a, b) {
    const d = Math.abs(a - b) % DAY_MIN;
    return Math.min(d, DAY_MIN - d);
  }
  Timing.circularMinutes = circMin;

  function hourDistance(a, b) {
    const d = Math.abs(a - b) % 24;
    return Math.min(d, 24 - d);
  }
  Timing.hourDistance = hourDistance;

  function quantileSorted(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /* Deterministic PRNG. The permutation test has to give the same
     answer every time the dashboard repaints — a p-value that
     flickers between renders reads as a bug, however honest the
     resampling. Seeded from the data, so it still varies between
     different post sets. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Order-independent by construction. The same posts listed in a
     different order are the same evidence, and a recommendation that
     changed when the posts table was re-sorted would be indefensible
     however small the change. */
  function seedFrom(obs) {
    let h = 2166136261;
    for (let i = 0; i < obs.length; i++) {
      h = (h + Math.imul(Math.round(obs[i].minute * 60) + 1, 2654435761)) >>> 0;
      h = (h + Math.imul(Math.round(obs[i].y * 1000) + 1, 40503)) >>> 0;
    }
    return (h ^ obs.length) >>> 0;
  }

  /* ---------- observations ---------- */

  /* One row per usable post: its exact position in the local day, its
     log-score, and its reception.

     Mod-pinned posts are dropped — a sticky's score reflects the
     moderator's decision, not the hour. So are removed posts, whose
     engagement stopped early for reasons unrelated to timing. */
  function observations(posts) {
    const obs = [];
    let excluded = 0;
    let provisional = 0;
    for (const p of posts || []) {
      if (!p || !p.created_utc) continue;
      if (p.stickied || p.removed) { excluded++; continue; }
      if (p.score_confirmed === false) provisional++;
      const d = new Date(p.created_utc * 1000);
      const y = Math.log1p(Math.max(0, p.score || 0));
      obs.push({
        minute: d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60,
        dow: d.getDay(),
        y: y,
        raw: y,
        ratio: (p.upvote_ratio != null && p.upvote_ratio > 0 && p.upvote_ratio <= 1) ? p.upvote_ratio : null,
      });
    }
    return { obs, excluded, provisional };
  }

  /* Clamp scores at three robust deviations of the community's own
     log-score distribution. On a log scale that threshold sits far
     out — a post has to be roughly two orders of magnitude off the
     median before it is touched — so ordinary successes pass through
     intact and only the genuine breakout stops steering the
     estimate. Capping rather than discarding keeps the post in the
     sample: it still says "this hour produced a hit", it just no
     longer says it loudly enough to drown out everything else. */
  function winsorise(obs) {
    const ys = obs.map((o) => o.y).sort((a, b) => a - b);
    const med = quantileSorted(ys, 0.5);
    const devs = ys.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    let scale = 1.4826 * quantileSorted(devs, 0.5);
    if (!(scale > 1e-6)) scale = (quantileSorted(ys, 0.75) - quantileSorted(ys, 0.25)) / 1.349;
    if (!(scale > 1e-6)) return 0;
    const hi = med + 3 * scale;
    const lo = med - 3 * scale;
    let clipped = 0;
    for (const o of obs) {
      if (o.y > hi) { o.y = hi; clipped++; }
      else if (o.y < lo) { o.y = lo; clipped++; }
    }
    return clipped;
  }

  /* ---------- one smoothing scale ---------- */

  /* Precomputes everything about a kernel width that does not depend
     on the scores, so a permutation only costs one pass of
     multiply-adds. Stored sparsely: at the narrow widths most posts
     are too far from most slots to matter. */
  function buildScale(obs, hMinutes) {
    const n = obs.length;
    const cutoff = hMinutes * CUTOFF_SIGMAS;
    const inv = 1 / (2 * hMinutes * hMinutes);
    const idx = new Array(SLOTS);
    const wts = new Array(SLOTS);
    const neff = new Float64Array(SLOTS);
    const shrink = new Float64Array(SLOTS);
    const coefA = new Float64Array(SLOTS);
    const coefB = new Float64Array(SLOTS);
    const se1 = new Float64Array(SLOTS);

    for (let k = 0; k < SLOTS; k++) {
      const centre = k * SLOT_MIN;
      const ii = [], ww = [];
      let sw = 0, sw2 = 0;
      for (let i = 0; i < n; i++) {
        const d = circMin(centre, obs[i].minute);
        if (d > cutoff) continue;
        const w = Math.exp(-(d * d) * inv);
        ii.push(i); ww.push(w);
        sw += w; sw2 += w * w;
      }
      idx[k] = Int32Array.from(ii);
      wts[k] = Float64Array.from(ww);
      /* Kish's effective sample size: how many equally-weighted posts
         this slot's estimate is really worth. */
      const ne = sw2 > 0 ? (sw * sw) / sw2 : 0;
      const denom = ne + SLOT_PRIOR;
      neff[k] = ne;
      shrink[k] = ne / denom;
      coefA[k] = sw > 0 ? ne / (sw * denom) : 0;
      coefB[k] = SLOT_PRIOR / denom;
      /* Standard error of the shrunk contrast against the baseline,
         in units of the residual standard deviation. Keeping sigma
         out of it matters: sigma is invariant under permutation, so
         the test statistic below needs no estimate of it at all. */
      se1[k] = ne >= 1 ? shrink[k] * Math.sqrt(1 / ne + 1 / n) : Infinity;
    }
    return { h: hMinutes, idx, wts, neff, shrink, coefA, coefB, se1 };
  }

  function curveAt(scale, values, grand) {
    const mu = new Float64Array(SLOTS);
    for (let k = 0; k < SLOTS; k++) {
      const ii = scale.idx[k], ww = scale.wts[k];
      let swy = 0;
      for (let t = 0; t < ii.length; t++) swy += ww[t] * values[ii[t]];
      mu[k] = scale.coefA[k] * swy + scale.coefB[k] * grand;
    }
    return mu;
  }

  /* The largest standardised lift at one smoothing width. */
  function scanScale(sc, values, grand) {
    let bestZ = -Infinity, bestSlot = 0;
    for (let k = 0; k < SLOTS; k++) {
      const se = sc.se1[k];
      if (!isFinite(se)) continue;
      const ii = sc.idx[k], ww = sc.wts[k];
      let swy = 0;
      for (let t = 0; t < ii.length; t++) swy += ww[t] * values[ii[t]];
      const mu = sc.coefA[k] * swy + sc.coefB[k] * grand;
      const z = (mu - grand) / se;
      if (z > bestZ) { bestZ = z; bestSlot = k; }
    }
    return { z: bestZ, slot: bestSlot };
  }

  /* Comparing raw scan statistics across smoothing widths would
     always crown the narrowest one. A 45-minute kernel gives the day
     about sixteen effectively independent looks; a three-and-a-half
     hour kernel gives it three. More looks means a higher maximum
     even when nothing is there, so the narrow width wins on
     opportunity rather than on evidence — which is how the first
     draft of this ended up recommending a random empty morning.

     So each width is first converted to a p-value against its own
     null distribution, and only then compared. The width with the
     least likely peak wins, and the overall p-value is the null
     distribution of that minimum, which pays for having tried
     several widths. This is the standard min-P permutation
     procedure. */
  function minP(nulls, B, S, observed) {
    /* p of a value at scale s, read off that scale's own null. */
    const sorted = [];
    for (let s = 0; s < S; s++) {
      const col = new Float64Array(B);
      for (let b = 0; b < B; b++) col[b] = nulls[b * S + s];
      col.sort();
      sorted.push(col);
    }
    /* Number of nulls at or above v, via binary search on the
       ascending column. */
    function atOrAbove(col, v) {
      let lo = 0, hi = col.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (col[mid] < v) lo = mid + 1; else hi = mid;
      }
      return col.length - lo;
    }

    let bestP = Infinity, bestScale = 0;
    const obsP = new Float64Array(S);
    for (let s = 0; s < S; s++) {
      obsP[s] = (1 + atOrAbove(sorted[s], observed[s].z)) / (1 + B);
      if (obsP[s] < bestP - 1e-12 ||
        (Math.abs(obsP[s] - bestP) <= 1e-12 && observed[s].z > observed[bestScale].z)) {
        bestP = obsP[s];
        bestScale = s;
      }
    }

    let ge = 0;
    for (let b = 0; b < B; b++) {
      let m = Infinity;
      for (let s = 0; s < S; s++) {
        const q = (1 + atOrAbove(sorted[s], nulls[b * S + s])) / (1 + B);
        if (q < m) m = q;
      }
      if (m <= bestP) ge++;
    }

    return { p: (1 + ge) / (1 + B), scale: bestScale, scaleP: obsP };
  }

  /* Leave-one-out error of the fitted curve, and of a flat line that
     ignores the clock. Not used to choose anything — the scan does
     that — but it gives an honest out-of-sample residual variance for
     the confidence interval, and answers "is this curve worth having
     at all" as a side effect. */
  function crossValidate(obs, hMinutes, grand, total) {
    const n = obs.length;
    const inv = 1 / (2 * hMinutes * hMinutes);
    const cutoff = hMinutes * CUTOFF_SIGMAS;
    let sse = 0, flatSse = 0;
    for (let i = 0; i < n; i++) {
      let sw = 0, sw2 = 0, swy = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const d = circMin(obs[i].minute, obs[j].minute);
        if (d > cutoff) continue;
        const w = Math.exp(-(d * d) * inv);
        sw += w; sw2 += w * w; swy += w * obs[j].y;
      }
      const ne = sw2 > 0 ? (sw * sw) / sw2 : 0;
      const pred = sw > 0 ? (ne * (swy / sw) + SLOT_PRIOR * grand) / (ne + SLOT_PRIOR) : grand;
      const e = obs[i].y - pred;
      sse += e * e;
      const flatE = obs[i].y - (total - obs[i].y) / (n - 1);
      flatSse += flatE * flatE;
    }
    return { cv: sse / n, flatCv: flatSse / n };
  }

  function variance(arr) {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    const m = s / arr.length;
    let v = 0;
    for (let i = 0; i < arr.length; i++) v += (arr[i] - m) * (arr[i] - m);
    return v / arr.length;
  }

  /* ---------- the model for one subreddit ---------- */

  /* posts — every loaded post from a single community.
     Returns null when there is nothing measurable. */
  Timing.fit = function (posts, opts) {
    opts = opts || {};
    const { obs, excluded, provisional } = observations(posts);
    const n = obs.length;
    const minSample = opts.minSample == null ? 4 : opts.minSample;
    if (n < Math.max(4, minSample)) return null;

    /* Canonical order, so the shuffles below draw the same sequence
       whatever order the posts arrived in. */
    obs.sort((a, b) => (a.minute - b.minute) || (a.y - b.y));

    const clipped = winsorise(obs);

    let total = 0;
    for (let i = 0; i < n; i++) total += obs[i].y;
    const grand = total / n;
    let totalVar = 0;
    for (let i = 0; i < n; i++) totalVar += (obs[i].y - grand) * (obs[i].y - grand);
    totalVar /= (n - 1);
    /* Every post in the community scored the same. Nothing to model,
       and nothing worth pretending about. */
    if (!(totalVar > 1e-9)) return null;

    /* A width so narrow that the average post has fewer than three
       neighbours inside it is fitting noise, not signal. */
    const minReach = (DAY_MIN * 3) / (n * 2.5066);
    let widths = SCALES.filter((hrs) => hrs * 60 >= minReach);
    if (!widths.length) widths = [SCALES[SCALES.length - 1]];
    if (opts.bandwidthHours) widths = [opts.bandwidthHours];

    const scales = widths.map((hrs) => buildScale(obs, hrs * 60));

    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = obs[i].y;

    const S = scales.length;
    const observed = scales.map((sc) => scanScale(sc, y, grand));

    /* ---- permutation test ----
       Reassign the observed scores to the observed timestamps at
       random and rescan. If shuffled data throws up peaks as high as
       the real one, the real one is a coincidence. Because the null
       is a distribution of maxima over the same grid and the same set
       of widths, searching all of them is already paid for. */
    const B = opts.permutations != null ? opts.permutations : (n > 400 ? 200 : 300);
    const rand = mulberry32(seedFrom(obs));
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    const shuffled = new Float64Array(n);
    const nulls = new Float64Array(B * S);
    for (let b = 0; b < B; b++) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
      }
      for (let i = 0; i < n; i++) shuffled[i] = y[idx[i]];
      for (let s = 0; s < S; s++) nulls[b * S + s] = scanScale(scales[s], shuffled, grand).z;
    }
    /* Add-one throughout, so a p-value can never be reported as
       exactly zero on a finite number of resamples. */
    const test = minP(nulls, B, S, observed);
    const p = test.p;

    const scale = scales[test.scale];
    const h = scale.h;
    const mu = curveAt(scale, y, grand);
    const peakIdx = observed[test.scale].slot;

    /* Residual scatter for the interval below. Taken out of sample so
       it is not flattered by the curve having been fitted to the same
       posts, and never allowed above the variance of doing nothing. */
    const cv = crossValidate(obs, h, grand, total);
    const sigma2 = Math.max(1e-9, Math.min(cv.cv, totalVar));

    /* ---- reception curve ----
       The same smoothing applied to upvote ratio, shrunk toward the
       community's own average by a flat four-post prior. Ratios vary
       far less than scores, so they do not need anything heavier. */
    let ratioCurve = null, ratioBase = null, ratioN = 0;
    {
      let rs = 0;
      for (let i = 0; i < n; i++) if (obs[i].ratio != null) { rs += obs[i].ratio; ratioN++; }
      if (ratioN >= 4) {
        ratioBase = rs / ratioN;
        const RATIO_PRIOR = 4;
        ratioCurve = new Float64Array(SLOTS);
        for (let k = 0; k < SLOTS; k++) {
          const ii = scale.idx[k], ww = scale.wts[k];
          let sw = 0, sw2 = 0, swr = 0;
          for (let t = 0; t < ii.length; t++) {
            const o = obs[ii[t]];
            if (o.ratio == null) continue;
            const w = ww[t];
            sw += w; sw2 += w * w; swr += w * o.ratio;
          }
          const ne = sw2 > 0 ? (sw * sw) / sw2 : 0;
          ratioCurve[k] = sw > 0
            ? (ne * (swr / sw) + RATIO_PRIOR * ratioBase) / (ne + RATIO_PRIOR)
            : ratioBase;
        }
      }
    }

    /* ---- choose the slot ----
       Slots within one standard error of the peak are not
       distinguishable from it, so picking the literal argmax is false
       precision. Take the contiguous run of tied slots around the
       peak — that is the posting window — and let reception choose
       the minute inside it. */
    const sePeak = Math.sqrt(sigma2) * scale.se1[peakIdx];
    const tieFloor = mu[peakIdx] - sePeak;

    let startK = peakIdx, endK = peakIdx;
    for (let step = 1; step < SLOTS; step++) {
      const k = (peakIdx - step + SLOTS) % SLOTS;
      if (mu[k] < tieFloor) break;
      startK = k;
    }
    for (let step = 1; step < SLOTS; step++) {
      const k = (peakIdx + step) % SLOTS;
      if (mu[k] < tieFloor) break;
      endK = k;
    }
    const runLength = ((endK - startK + SLOTS) % SLOTS) + 1;

    let bestIdx = peakIdx;
    let ratioDecided = false;
    if (ratioCurve && ratioN >= 8 && runLength > 1 && runLength < SLOTS) {
      let bestRatio = -Infinity, pick = peakIdx;
      for (let step = 0; step < runLength; step++) {
        const k = (startK + step) % SLOTS;
        if (ratioCurve[k] > bestRatio) { bestRatio = ratioCurve[k]; pick = k; }
      }
      /* Only move if reception actually differs across the window;
         chasing half a point of ratio is chasing noise. */
      if (pick !== peakIdx && bestRatio - ratioCurve[peakIdx] >= 0.005) {
        bestIdx = pick;
        ratioDecided = true;
      }
    }

    /* ---- lift and its interval ----
       exp() of a difference of log-space means is a ratio of
       geometric means, which under a log-normal is a ratio of
       medians. So the lift reads as "the typical post at this time
       against the typical post here", not "the biggest post". */
    const delta = mu[bestIdx] - grand;
    const seDelta = Math.sqrt(sigma2) * scale.se1[bestIdx];
    const liftPct = (Math.exp(delta) - 1) * 100;
    const liftLow = (Math.exp(delta - Z95 * seDelta) - 1) * 100;
    const liftHigh = (Math.exp(delta + Z95 * seDelta) - 1) * 100;

    /* Do the two curves move together? A negative correlation means
       the high-scoring hour is also the worse-received one, which is
       worth saying out loud. */
    let ratioCorr = null;
    if (ratioCurve) {
      let sx = 0, sy = 0;
      for (let k = 0; k < SLOTS; k++) { sx += mu[k]; sy += ratioCurve[k]; }
      const mx = sx / SLOTS, my = sy / SLOTS;
      let sxy = 0, sxx = 0, syy = 0;
      for (let k = 0; k < SLOTS; k++) {
        const dx = mu[k] - mx, dy = ratioCurve[k] - my;
        sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
      }
      if (sxx > 1e-12 && syy > 1e-12) ratioCorr = sxy / Math.sqrt(sxx * syy);
    }

    /* ---- day of week ----
       The same question at one seventh of the resolution. Only named
       when the shuffle says the days really differ. */
    const dow = dayOfWeekEffect(obs, grand, rand);

    const signal = classify(p, liftPct, liftLow, scale.neff[bestIdx], n, runLength * SLOT_MIN);

    /* Busiest slot is an activity measure, not a performance one.
       Kept as an explicit fallback for communities with no timing
       signal, and always labelled as such. */
    let busyIdx = 0, busyMax = -Infinity;
    for (let k = 0; k < SLOTS; k++) {
      let sw = 0;
      const ww = scale.wts[k];
      for (let t = 0; t < ww.length; t++) sw += ww[t];
      if (sw > busyMax) { busyMax = sw; busyIdx = k; }
    }

    return {
      n: n,
      excluded: excluded,
      provisional: provisional,
      clipped: clipped,
      bandwidthHours: h / 60,
      widthsTried: widths.length,
      cv: cv.cv,
      flatCv: cv.flatCv,
      beatsFlat: cv.cv < cv.flatCv,
      grandLog: grand,
      sigma: Math.sqrt(sigma2),
      /* Reported in proper standard-error units. The scan works with
         sigma factored out, since it cancels between the observed
         statistic and its null. */
      z: observed[test.scale].z / Math.sqrt(sigma2),
      scaleP: Array.from(test.scaleP),
      curve: mu,
      curveVariance: variance(mu),
      ratioCurve: ratioCurve,
      /* The fitted curve and the posts behind it, both on the score
         scale, so the panel chart can show the estimate against the
         data it came from — including the breakout the estimate is
         deliberately not chasing. */
      curveScores: Array.from(mu, (v) => Math.expm1(v)),
      points: obs.map((o) => ({
        x: o.minute / 60,
        y: Math.max(1, Math.expm1(o.raw)),
        capped: o.raw !== o.y,
      })),

      slot: bestIdx * SLOT_MIN,
      slotLabel: Timing.formatSlot(bestIdx * SLOT_MIN),
      peakSlot: peakIdx * SLOT_MIN,
      hour: Math.round(bestIdx * SLOT_MIN / 60) % 24,
      window: {
        start: startK * SLOT_MIN,
        end: ((endK + 1) % SLOTS) * SLOT_MIN,
        slots: runLength,
        minutes: runLength * SLOT_MIN,
      },

      lift: liftPct,
      liftLow: liftLow,
      liftHigh: liftHigh,
      typicalScore: Math.expm1(mu[bestIdx]),
      baselineScore: Math.expm1(grand),
      effectiveN: scale.neff[bestIdx],

      p: p,
      permutations: B,
      signal: signal,

      ratioAt: ratioCurve ? ratioCurve[bestIdx] : null,
      ratioBase: ratioBase,
      ratioN: ratioN,
      ratioCorr: ratioCorr,
      ratioDecided: ratioDecided,

      dow: dow,

      busiestSlot: busyIdx * SLOT_MIN,
      busiestHour: Math.round(busyIdx * SLOT_MIN / 60) % 24,
    };
  };

  /* Three bands rather than a significant/not verdict, because the
     difference between "probably real but thin" and "nothing here"
     changes what you do next. Each band means what it says: across
     pure-noise samples the strong band fires about one time in
     twenty and likely about one in seven, which is what p <= .05 and
     p <= .15 are for. The p-value and the interval are shown
     alongside regardless, so nobody has to take the band's word.

     Under eight posts nothing is awarded at all. A handful of posts
     cannot separate a time of day from the order they arrived in,
     whatever the arithmetic says. */
  const HARD_FLOOR = 8;

  /* Effect size gates alongside the p-values. A slot can be
     statistically distinguishable from the community's baseline and
     still not be worth waiting for: five percent on a typical post is
     a finding about the data, not a reason to schedule anything. The
     weaker the evidence, the larger the effect has to be to earn a
     mention at all.

     The window gate is the other half of the same idea. When the
     slots that are statistically tied with the peak span half the
     day, the model has found that afternoons beat nights, not a time
     to post, and naming a quarter hour inside that would be
     precision the fit does not have. */
  function classify(p, liftPct, liftLow, effN, n, windowMinutes) {
    if (n < HARD_FLOOR || !(effN >= 3)) return "none";
    if (windowMinutes > 720) return "none";
    /* Calling something strong off three posts is a contradiction in
       terms whatever the arithmetic says. */
    if (p <= 0.05 && liftLow > 0 && effN >= 5) return "strong";
    if (p <= 0.15 && liftPct >= 15) return "likely";
    if (p <= 0.25 && liftPct >= 25) return "weak";
    return "none";
  }

  function dayOfWeekEffect(obs, grand, rand) {
    const n = obs.length;
    if (n < 14) return null;
    const cnt = new Float64Array(7);
    for (let i = 0; i < n; i++) cnt[obs[i].dow]++;

    const PRIOR = 3;
    const means = new Float64Array(7);
    function shrunkMeans(values, out) {
      const s = new Float64Array(7);
      const c = new Float64Array(7);
      for (let i = 0; i < n; i++) { s[obs[i].dow] += values[i]; c[obs[i].dow]++; }
      for (let d = 0; d < 7; d++) out[d] = (s[d] + PRIOR * grand) / (c[d] + PRIOR);
      return out;
    }

    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = obs[i].y;
    shrunkMeans(y, means);

    let best = -1, bestVal = -Infinity;
    for (let d = 0; d < 7; d++) {
      if (cnt[d] < 3) continue;
      if (means[d] > bestVal) { bestVal = means[d]; best = d; }
    }
    if (best < 0) return null;
    const observedMax = bestVal - grand;

    const B = 300;
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    const shuffled = new Float64Array(n);
    const scratch = new Float64Array(7);
    let ge = 0;
    for (let b = 0; b < B; b++) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
      }
      for (let i = 0; i < n; i++) shuffled[i] = y[idx[i]];
      shrunkMeans(shuffled, scratch);
      let m = -Infinity;
      for (let d = 0; d < 7; d++) if (cnt[d] >= 3 && scratch[d] > m) m = scratch[d];
      if (m - grand >= observedMax) ge++;
    }
    const p = (1 + ge) / (1 + B);

    return {
      day: best,
      name: DOW_NAMES[best],
      short: DOW_SHORT[best],
      count: cnt[best],
      lift: (Math.exp(observedMax) - 1) * 100,
      p: p,
      significant: p <= 0.15,
    };
  }

  /* ---------- when to actually post next ---------- */

  /* Below this much of the window left, "post now" is not worth saying:
     by the time anything is written the window has shut. */
  const OPEN_FLOOR_MIN = 5;

  /* The recommendation is a clock time; this turns it into a date.
     Honours a significant day-of-week effect by rolling forward to that
     weekday.

     The peak minute is the middle of a tied window, not a deadline —
     everything inside `row.window` scored statistically the same, which
     is why the row reports "19:45–21:15 window" beside it. So the first
     question is not "when does the peak next come round" but "am I
     standing in the window right now", and if the answer is yes the
     answer to "when should I post" is now.

     Asking only about the peak, as this used to, produced the worst
     possible reading of a good moment: at 20:26, with a window running
     19:45–21:15 and a peak at 20:45, it reported "tomorrow 20:45, in 1d
     0h" — advice to wait 24 hours from inside the window it was
     recommending. Two things conspired. The peak was 19 minutes off and
     a 20-minute lead guard rolled anything nearer than that to the next
     day, turning a near miss into a whole day's wait; and the window,
     which was the part that made the moment fine, was never consulted.

     The lead guard is gone with it. It existed so the tool would not
     propose a slot too soon to act on, but a day's delay is a far worse
     answer than "in 3 minutes", and inside a ninety-minute window the
     exact minute never mattered anyway. */
  Timing.nextOccurrence = function (row, now, opts) {
    opts = opts || {};
    if (!row || row.slot == null) return null;
    const base = now instanceof Date ? new Date(now.getTime()) : new Date();
    const midnight = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
    const nowMin = (base.getTime() - midnight.getTime()) / 60000;
    const wantDay = (row.dowDay != null && row.dowDay >= 0) ? row.dowDay : null;

    const win = row.window && row.window.minutes > 0 && row.window.slots < SLOTS
      ? row.window : null;
    if (win) {
      /* Two candidates: the window that started today, and the one that
         started yesterday and is still running past midnight. */
      for (const daysBack of [0, 1]) {
        const start = win.start - daysBack * 1440;
        const end = start + win.minutes;
        if (nowMin < start || nowMin >= end) continue;
        const day = new Date(midnight.getTime() - daysBack * 86400000);
        if (wantDay != null && day.getDay() !== wantDay) continue;
        const left = Math.round(end - nowMin);
        /* Nearly shut. Fall through and name the next one instead. */
        if (left < OPEN_FLOOR_MIN) break;
        return {
          date: new Date(base.getTime()),
          open: true,
          inMinutes: 0,
          closesInMinutes: left,
          closesAt: Timing.formatSlot(win.end),
          inLabel: `open until ${Timing.formatSlot(win.end)}`,
          dayWord: "today",
          label: "now",
        };
      }
    }

    const target = new Date(midnight.getTime());
    target.setMinutes(row.slot);
    while (target <= base) target.setDate(target.getDate() + 1);

    if (wantDay != null) {
      let guard = 0;
      while (target.getDay() !== wantDay && guard++ < 8) target.setDate(target.getDate() + 1);
    }

    const deltaMin = Math.round((target.getTime() - base.getTime()) / 60000);
    const sameDay = target.toDateString() === base.toDateString();
    const tomorrow = new Date(base.getTime() + 86400000).toDateString() === target.toDateString();
    const dayWord = sameDay ? "today" : tomorrow ? "tomorrow" : DOW_SHORT[target.getDay()];

    return {
      date: target,
      open: false,
      inMinutes: deltaMin,
      inLabel: humanDelta(deltaMin),
      dayWord: dayWord,
      label: `${dayWord} ${Timing.formatSlot(row.slot)}`,
    };
  };

  function humanDelta(minutes) {
    if (minutes < 1) return "in under a minute";
    if (minutes < 60) return `in ${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h < 24) return m ? `in ${h}h ${m}m` : `in ${h}h`;
    const d = Math.floor(h / 24);
    return `in ${d}d ${h % 24}h`;
  }
  Timing.humanDelta = humanDelta;

  /* ---------- the whole-collection model ---------- */

  /* Groups posts by subreddit, fits each independently and wraps the
     lot in a cross-community summary. Row shape stays compatible with
     the previous estimator so existing renderers keep working; the
     statistical fields are additions. */
  Timing.model = function (posts, opts) {
    opts = opts || {};
    const minSample = opts.minSample == null ? 4 : opts.minSample;
    const solidSample = opts.solidSample == null ? 12 : opts.solidSample;

    const groups = new Map();
    for (const p of posts || []) {
      const key = (p.subreddit || "").toLowerCase();
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { name: p.subreddit, posts: [] });
      groups.get(key).posts.push(p);
    }

    const rows = [];
    for (const [key, group] of groups.entries()) {
      rows.push(Timing.row(key, group.name, group.posts, { minSample, solidSample }));
    }

    rows.sort((a, b) => b.count - a.count);
    return Timing.summarize(rows, { minSample: minSample });
  };

  /* A few hundred reshuffles per community is cheap once and wasteful
     forty times, and the app re-renders the KPI row after every batch
     of a long fetch. The fit is a pure function of the posts, so a
     small cache keyed on their identities and scores makes repeat
     renders free and leaves only genuinely changed communities to
     recompute. */
  const fitCache = new Map();
  const FIT_CACHE_MAX = 96;

  function fitSignature(key, posts, minSample) {
    /* Summed rather than folded, so re-sorting the posts table does
       not miss the cache and recompute an identical answer. */
    let h = 0;
    for (const p of posts) {
      let one = 2166136261;
      const id = p.id || "";
      for (let i = 0; i < id.length; i++) { one ^= id.charCodeAt(i); one = Math.imul(one, 16777619); }
      one ^= (p.score || 0); one = Math.imul(one, 16777619);
      one ^= Math.round(p.created_utc || 0); one = Math.imul(one, 16777619);
      h = (h + (one >>> 0)) >>> 0;
    }
    return `${key}|${posts.length}|${minSample}|${h}`;
  }

  function cachedFit(key, posts, minSample) {
    const sig = fitSignature(key, posts, minSample);
    if (fitCache.has(sig)) return fitCache.get(sig);
    const fit = Timing.fit(posts, { minSample: minSample });
    if (fitCache.size >= FIT_CACHE_MAX) fitCache.delete(fitCache.keys().next().value);
    fitCache.set(sig, fit);
    return fit;
  }

  /* One renderable row. Exposed so callers that assemble rows from
     more than one source — the campaign workspace borrows a
     subreddit's ambient rhythm when the campaign's own posts there
     are too thin — can build them the same way. */
  Timing.row = function (key, name, posts, opts) {
    opts = opts || {};
    const minSample = opts.minSample == null ? 4 : opts.minSample;
    const solidSample = opts.solidSample == null ? 12 : opts.solidSample;
    const agg = window.Analysis ? Analysis.aggregate(posts) : null;
    const fit = cachedFit(key, posts, minSample);

    const row = {
      key: key,
      subreddit: name,
      count: posts.length,
      agg: agg,
      fit: fit,
      quiet: agg ? quietWindow(agg.byHour) : null,
      busiestHour: agg ? argmax(agg.byHour) : -1,
      velocityHour: agg ? bestVelocityHour(agg) : -1,
      enough: !!fit && posts.length >= minSample,
      confidence: posts.length >= solidSample ? "solid"
        : posts.length >= minSample ? "thin"
          : "insufficient",
    };

    if (!fit) {
      row.bestHour = -1;
      row.slot = null;
      row.slotLabel = null;
      row.lift = 0;
      row.signal = "none";
      row.bestDow = agg ? argmax(agg.byDow) : -1;
      row.bestHourSample = 0;
      return row;
    }

    row.bestHour = fit.hour;
    row.slot = fit.slot;
    row.slotLabel = fit.slotLabel;
    row.window = fit.window;
    /* Unrounded. An interval whose lower bound is +0.4% is the
       difference between a finding and a coincidence, and rounding it
       here would print "+0%" beside a claim that it clears zero. The
       renderers decide how many digits to show. */
    row.lift = fit.lift;
    row.liftLow = fit.liftLow;
    row.liftHigh = fit.liftHigh;
    row.effectiveN = fit.effectiveN;
    row.typicalScore = fit.typicalScore;
    row.baselineScore = fit.baselineScore;
    row.p = fit.p;
    row.permutations = fit.permutations;
    row.signal = fit.signal;
    row.ratioAt = fit.ratioAt;
    row.ratioBase = fit.ratioBase;
    row.ratioCorr = fit.ratioCorr;
    row.ratioDecided = fit.ratioDecided;
    row.clipped = fit.clipped;
    row.excluded = fit.excluded;
    row.bandwidthHours = fit.bandwidthHours;
    row.busiestSlot = fit.busiestSlot;

    if (fit.dow && fit.dow.significant) {
      row.bestDow = fit.dow.day;
      row.dowDay = fit.dow.day;
      row.dowName = fit.dow.name;
      row.dowShort = fit.dow.short;
      row.dowLift = Math.round(fit.dow.lift);
      row.dowP = fit.dow.p;
    } else {
      /* Fall back to the busiest day, but do not pretend it is a
         performance finding. */
      row.bestDow = agg ? argmax(agg.byDow) : -1;
      row.dowDay = null;
    }

    /* Kept for renderers that still count posts in the peak hour. */
    row.bestHourSample = agg ? agg.byHour[fit.hour] || 0 : 0;
    row.next = Timing.nextOccurrence(row);
    return row;
  };

  function argmax(arr) {
    let best = -1, val = -Infinity;
    for (let i = 0; i < (arr || []).length; i++) if (arr[i] > val) { val = arr[i]; best = i; }
    return best;
  }

  function bestVelocityHour(agg) {
    let best = -1, val = -Infinity;
    for (let h = 0; h < 24; h++) {
      if (agg.byHour[h] >= 2 && agg.avgVelocityByHour[h] > val) {
        val = agg.avgVelocityByHour[h];
        best = h;
      }
    }
    return best;
  }

  /* Longest run of consecutive hours with no posts at all, wrapping
     midnight. Reported as a window because "quiet 02:00-07:00" reads
     better than a list of six hour numbers. */
  function quietWindow(byHour) {
    if (!byHour) return null;
    let bestStart = -1, bestLen = 0, start = -1, len = 0;
    for (let i = 0; i < 48; i++) {
      const h = i % 24;
      if (!byHour[h]) {
        if (len === 0) start = h;
        len++;
        if (len > bestLen && len <= 24) { bestLen = len; bestStart = start; }
      } else {
        len = 0;
      }
    }
    if (bestLen < 3 || bestLen >= 24) return null;
    return { start: bestStart, end: (bestStart + bestLen) % 24, length: bestLen };
  }
  Timing.quietWindow = quietWindow;

  /* ---------- cross-community summary ---------- */

  /* Weakest evidence sorts last everywhere it is used. */
  const STRENGTH = { strong: 0, likely: 1, weak: 2 };

  Timing.summarize = function (rows, opts) {
    opts = opts || {};
    const minSample = opts.minSample == null ? 4 : opts.minSample;
    const measured = rows.filter((r) => r.enough);
    /* "Ranked" is the set worth acting on. A community whose scores
       demonstrably do not depend on posting time does not belong in a
       list of best times, however many posts it has. */
    const ranked = measured.filter((r) => r.signal && r.signal !== "none");
    const flat = measured.filter((r) => !r.signal || r.signal === "none");

    /* Order by how much the recommendation is worth acting on, not by
       how many posts happened to be loaded. Every caller shows a
       handful of these before truncating, and under a post-count sort
       those first few were whichever communities the fetch had pulled
       most from — an ordering with nothing to say about when to post.
       Evidence first, then the size of the edge it buys. */
    ranked.sort((a, b) =>
      (STRENGTH[a.signal] - STRENGTH[b.signal]) ||
      ((b.lift || 0) - (a.lift || 0)) ||
      a.subreddit.localeCompare(b.subreddit));

    let spreadMinutes = 0;
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) {
        spreadMinutes = Math.max(spreadMinutes, circMin(ranked[i].slot, ranked[j].slot));
      }
    }

    /* The answer to "so when is my next post": the soonest actionable
       window, but a well-evidenced slot tomorrow beats a shaky one in
       an hour, so strength of evidence orders the list first. */
    const nextUp = ranked
      .filter((r) => r.next)
      .sort((a, b) => (STRENGTH[a.signal] - STRENGTH[b.signal]) || (a.next.inMinutes - b.next.inMinutes))[0] || null;

    return {
      rows: rows,
      ranked: ranked,
      measured: measured,
      flat: flat,
      skipped: rows.filter((r) => !r.enough),
      spreadMinutes: spreadMinutes,
      spread: Math.round(spreadMinutes / 60),
      /* Ninety minutes of slack: below that the communities are close
         enough that one posting slot serves all of them. */
      agree: ranked.length > 1 && spreadMinutes <= 90,
      nextUp: nextUp,
      minSample: minSample,
      tz: window.Util && Util.getTzLabel ? Util.getTzLabel() : "",
    };
  };

  /* ---------- presentation helpers ---------- */

  const SIGNAL_LABELS = {
    strong: "strong",
    likely: "likely",
    weak: "weak",
    none: "no signal",
  };
  Timing.signalLabel = function (signal) { return SIGNAL_LABELS[signal] || "no signal"; };

  /* p-values are rendered as thresholds rather than digits. "p = 0.03"
     invites a precision that a few hundred resamples do not have. */
  Timing.pLabel = function (p) {
    if (p == null) return "";
    if (p <= 0.01) return "p < .01";
    if (p <= 0.05) return "p < .05";
    if (p <= 0.15) return "p < .15";
    if (p <= 0.25) return "p < .25";
    return "p > .25";
  };

  /* "+38% (95% CI +9% to +76%)" */
  Timing.liftLabel = function (row) {
    if (!row || row.lift == null) return "";
    const sign = (v) => (v > 0 ? "+" : "") + Math.round(v) + "%";
    if (row.liftLow == null || row.liftHigh == null) return sign(row.lift);
    return `${sign(row.lift)} (95% CI ${sign(row.liftLow)} to ${sign(row.liftHigh)})`;
  };

  Timing.windowLabel = function (row) {
    if (!row || !row.window) return "";
    if (row.window.slots >= SLOTS) return "all day";
    return `${Timing.formatSlot(row.window.start)}–${Timing.formatSlot(row.window.end)}`;
  };

  window.Timing = Timing;
})();
