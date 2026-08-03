/* =====================================================================
 * SUBREDDIT INDEX
 * ---------------------------------------------------------------------
 * A persistent, local index of subreddit metadata plus the machinery to
 * compare two pieces of text by meaning-ish overlap.
 *
 * WHY THIS EXISTS
 * Discovery used to score a candidate by counting substring hits of the
 * campaign's keywords inside `title + public_description + name`. That
 * had three problems: `about.json` was only fetched for a handful of
 * candidates so most were scored on whatever the search endpoint
 * happened to return; a substring match treats "vote" inside "devoted"
 * as a hit; and nothing was reused between runs, so every discovery pass
 * paid full network cost again.
 *
 * The index fixes all three. Records are cached in IndexedDB for 30
 * days, each carries a pre-computed weighted term vector, and matching
 * is cosine similarity over those vectors with an inverse-document-
 * frequency weight derived from the index itself.
 * ===================================================================== */
(function () {
  const SubIndex = {};

  const DB_NAME = "rj-subindex";
  const DB_VERSION = 1;
  const STORE = "subs";
  const TTL_MS = 30 * 24 * 60 * 60 * 1000; /* 30 days */
  const LS_KEY = "rj.subindex";
  const LS_MAX = 400; /* localStorage fallback keeps only the newest N */

  /* In-memory mirror. Keyed by lowercase display name. */
  const mem = new Map();
  let loaded = false;
  let dbPromise = null;

  /* ==================================================================
   * TOKENIZATION
   * ================================================================== */

  /* Words that carry no topical signal in a subreddit description.
   * Deliberately includes subreddit boilerplate ("welcome", "community",
   * "discussion", "subreddit", "please", "rules") because almost every
   * sidebar contains them, so they would otherwise dominate the overlap
   * between any two communities. */
  const STOP = new Set(([
    "the a an and or but if then than that this these those there here",
    "is are was were be been being am do does did doing have has had having",
    "of to in on at by for with from into over under about across after before",
    "as it its it's we our us you your yours they them their he she his her",
    "i me my mine not no nor so too very can will just should now also",
    "what which who whom whose when where why how all any both each few more",
    "most other some such only own same s t don't should've",
    "subreddit sub reddit reddits community communities welcome please read rules rule",
    "post posts posting discussion discussions discuss talk talking share sharing",
    "place home official unofficial dedicated everything anything news new latest",
    "questions question ask asking answers help thread threads content",
    "members member users user people group forum page site link links",
    "get make made take taking use using like want need know think say said",
    "one two three first second last next best good great",
    "day days week weeks month months year years time times",
    "http https www com org net html json amp gt lt nbsp",
    /* Generic nouns and filler that read as topical because they are
     * nouns, but describe nothing. Without these a post about a *person*
     * being arrested matched r/PersonOfInterest, a TV-show sub, on the
     * single word they had in common. Deliberately excludes words that
     * look generic but carry civic meaning: state, case, right, court,
     * party, movement, women, men, race. */
    "person persons someone somebody anyone anybody everyone everybody nobody",
    "thing things something anything nothing stuff lot lots bit way ways",
    "kind sort really actually even much maybe perhaps always never often",
    "going gone went come came coming look looking looks seen tell told",
    "give given gives put keep let may might must would could shall around",
  ].join(" ")).split(/\s+/).filter(Boolean));

  /* The second tier, and the more useful one.
   *
   * A blocklist is the wrong shape for this problem. Every word it does
   * not contain reads as a topic, so junk like "against", "raising" and
   * "far" ranked as subject matter; and every word it does contain is
   * gone everywhere, so blocking "far" to be rid of it would take "far
   * right" with it. Both failures come from one decision being asked to
   * cover two different cases.
   *
   * These words are kept in the token stream, so phrases still form
   * across them, but they are worth almost nothing standing alone and
   * are never shown to anyone as a keyword. "far" scores 0.1; "far
   * right" scores like any other phrase. The same escape hatch is why
   * this list can afford to be generous: a word listed here that turns
   * out to matter still reaches the vector through its phrase, so the
   * cost of a wrong call is small and the cost of an omission is a junk
   * keyword in someone's face. Anything doubtful belongs here rather
   * than above.
   *
   * Written in plain English and stemmed on the way in, so "raising",
   * "raised" and "raise" are one entry rather than three chances to
   * miss one. */
  const WEAK = weakSet([
    /* Prepositions and particles the hard list never covered. These are
     * the ones that produced "against" as a topic. */
    "against toward towards beyond despite among amongst within without along",
    "behind below beneath beside besides between during except inside outside",
    "near onto past since through throughout until till unto upon versus",
    "amid amidst plus minus per via off out onto above",
    /* Discourse connectives. */
    "although though however therefore thus hence meanwhile moreover furthermore",
    "nevertheless nonetheless otherwise instead whereas whether while whilst",
    "unless yet still else whenever wherever whatever whoever regardless",
    "either neither rather already soon later earlier recently currently",
    "finally eventually immediately suddenly again once twice ago",
    /* Degree and scope. Never a subject, frequently a modifier: "far
     * right", "deeply unpopular", "widely reported". */
    "far highly deeply widely heavily largely mostly mainly fully partly",
    "barely hardly nearly almost quite fairly somewhat extremely incredibly",
    "totally completely entirely absolutely utterly slightly especially",
    "particularly generally usually sometimes occasionally rarely seldom",
    "enough merely simply indeed certainly probably possibly definitely",
    /* Light verbs. The ones that describe an action without naming a
     * subject — "raising" was the complaint, and it has fifty siblings. */
    "raising raise remember bring brought holding hold held showing show",
    "shown showed finding find found seeming seem becoming become began",
    "begin beginning starting start stopping stop continue trying try",
    "turning turn calling call leaving leave came remain remaining appear",
    "happen occur exist include including involve provide receive report",
    "reporting announce reveal claim suggest consider allow according",
    "follow following expect believe decide explain describe mention",
    "adding added ending ended hit cut miss beat broke break drop dropped",
    "fall fell rise rose grow grew move moved put gave gone plan planned",
    "pass passed passing filed filing sent send got getting",
    /* Number words. "three" was already on the hard list and the rest
     * of the count was not, so "six" read as a subject. */
    "four five six seven eight nine ten eleven twelve twenty thirty",
    "forty fifty sixty seventy eighty ninety hundred",
    /* Light nouns. Nouns by grammar, subjects by nobody's reckoning. */
    "article part piece story point level number amount side end top bottom",
    "line list area term form type set fact idea reason result example",
    "sense view note item matter detail aspect factor element feature",
    "process situation condition position status effect impact",
    "percent percentage total figure",
    /* Quantity and size. "young" and "low" stay here rather than in the
     * hard list precisely because "young voters" and "low income" are
     * real, and this tier gives them back through the phrase. */
    "several various multiple numerous plenty couple dozen half whole",
    "entire overall general specific particular certain common different",
    "similar actual real true main major minor big small large huge tiny",
    "high low long short old young full empty little least",
  ].join(" ").split(/\s+/).filter(Boolean));

  /* What a weak word is worth on its own. Not zero: a description made
   * entirely of them should still be comparable to another one, and a
   * hard zero would make its vector empty. */
  const WEAK_WEIGHT = 0.1;

  /* Conservative suffix stripping. Full Porter stemming over-merges
   * civic vocabulary (organise/organic), so this only folds the endings
   * that reliably preserve meaning. */
  function stem(word) {
    let w = word;
    if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
    if (w.length > 4 && w.endsWith("sses")) return w.slice(0, -2);
    if (w.length > 4 && (w.endsWith("ches") || w.endsWith("shes") || w.endsWith("xes"))) return w.slice(0, -2);
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
    if (w.length > 6 && w.endsWith("ing")) {
      const base = w.slice(0, -3);
      return base.length > 3 ? base : w;
    }
    if (w.length > 5 && w.endsWith("ed") && !w.endsWith("eed")) {
      const base = w.slice(0, -2);
      return base.length > 3 ? base : w;
    }
    return w;
  }

  SubIndex.stem = stem;

  function weakSet(words) {
    const out = new Set();
    for (const w of words) {
      if (!w) continue;
      out.add(w);
      out.add(stem(w));
    }
    return out;
  }

  /* Exposed so the post-title tokenizer in analysis.js can share one
   * curated list rather than drifting from this one. */
  SubIndex.STOP = STOP;
  SubIndex.WEAK = WEAK;

  /* True for a term that should never be offered as a keyword. Phrases
   * are judged by their parts: "far right" is not weak, "old news" is. */
  SubIndex.isWeak = function (term) {
    const t = String(term || "");
    if (t.indexOf(" ") < 0) return WEAK.has(t);
    return t.split(" ").every((w) => WEAK.has(w));
  };

  /* stem -> the spelling it was most often written as. Stems are index
   * keys, not words: showing someone that their post matched on
   * "organiz" is showing them the plumbing. This costs one map write
   * per token and turns the whole UI back into English. */
  const surface = new Map();
  const SURFACE_MAX = 20000;

  /* The spelling people actually use, by count. Shortest-wins was the
   * obvious rule and the wrong one: it renders the stem of
   * "bargaining" as "bargain" the moment the shorter word appears once
   * anywhere, which is a different word. Whichever form was written
   * most is the form the reader will recognise. */
  function noteSurface(stemmed, word) {
    let counts = surface.get(stemmed);
    if (!counts) {
      if (surface.size >= SURFACE_MAX) return;
      counts = {};
      surface.set(stemmed, counts);
    }
    counts[word] = (counts[word] || 0) + 1;
  }

  function bestSurface(stemmed) {
    const counts = surface.get(stemmed);
    if (!counts) return stemmed;
    let best = stemmed, bestN = -1;
    for (const word in counts) {
      const n = counts[word];
      /* Ties to the shorter form, so a stem seen once each way still
       * settles on one answer rather than on iteration order. */
      if (n > bestN || (n === bestN && word.length < best.length)) {
        best = word;
        bestN = n;
      }
    }
    return best;
  }

  /* A term as a person would write it. Falls back to the stem, which is
   * what it was before, so nothing can end up blank. */
  SubIndex.surfaceOf = function (term) {
    const t = String(term || "");
    if (t.indexOf(" ") < 0) return bestSurface(t);
    return t.split(" ").map(bestSurface).join(" ");
  };

  /* Split text into stemmed, stopword-filtered terms. CamelCase in
   * subreddit names is split too, so `MedicareForAll` contributes
   * `medicare` and `all` rather than one opaque token.
   *
   * Weak words stay in. They are nearly weightless on their own — see
   * addText — but dropping them here would splice unrelated words into
   * neighbours: "vote against the bill" would form the phrase "vote
   * bill", which nobody wrote. */
  /* Where one phrase stops and the next begins. Bigrams used to be
   * formed straight down the token stream, so a sidebar reading "wage
   * theft, fight for better pay" produced the phrase "theft fight" —
   * two words that were never next to each other in anything anyone
   * wrote, scored at 1.5x for being a phrase, and then offered to the
   * user as the reason for a match. */
  const CLAUSE = /[.,;:!?()\[\]{}"|/\\\u2013\u2014\u2022\n\r]+/;

  /* Flat list of terms, adjacency discarded. Callers that build phrases
   * from curated text — a sphere's trigger list, where the author wrote
   * "right to work" meaning it as a unit — want this, because there the
   * words either side of a dropped "to" really do belong together. */
  SubIndex.tokenize = function (text) {
    const runs = SubIndex.tokenizeRuns(text);
    return runs.length === 1 ? runs[0] : [].concat.apply([], runs);
  };

  /* The same terms, grouped into stretches that were genuinely next to
   * each other in the source. Only these should form phrases.
   *
   * The chain "theft fight, fight better, better conditions, conditions
   * job" was being offered as the reason a post matched r/antiwork.
   * None of those phrases exists. The sidebar says "wage theft and the
   * fight for better conditions on the job", and because every word
   * between them was dropped as a stopword, every survivor ended up
   * adjacent to every other one — then scored at the 1.5x a phrase
   * earns for being more specific than its parts. A run therefore ends
   * at punctuation and at any word that does not survive tokenizing.
   * "wage theft" and "better conditions" come through; the four
   * inventions do not. */
  SubIndex.tokenizeRuns = function (text) {
    if (!text) return [];
    const spaced = String(text)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .toLowerCase();
    const runs = [];
    for (const clause of spaced.split(CLAUSE)) {
      let run = [];
      for (const word of clause.split(/[^a-z'-]+/)) {
        const s = accept(word);
        if (s) {
          run.push(s);
        } else if (run.length) {
          runs.push(run);
          run = [];
        }
      }
      if (run.length) runs.push(run);
    }
    return runs;
  };

  /* The stemmed term this word contributes, or "" if it contributes
   * nothing — which is also the signal to end the run. */
  function accept(word) {
    if (!word) return "";
    /* Possessives and contracted verbs are not part of the word.
     * Without this, "here's" survives as a term of its own — "here" is
     * on the hard list, "here's" was not, and no list will ever catch
     * every clitic. */
    const clean = word.replace(/^['-]+|['-]+$/g, "").replace(/'(s|re|ve|ll|d|m|t)$/, "");
    if (clean.length < 3 || STOP.has(clean)) return "";
    const s = stem(clean);
    if (s.length < 3 || STOP.has(s)) return "";
    noteSurface(s, clean);
    return s;
  }

  SubIndex.bigrams = function (terms) {
    const out = [];
    for (let i = 0; i < terms.length - 1; i++) out.push(terms[i] + " " + terms[i + 1]);
    return out;
  };

  /* ==================================================================
   * VECTORS
   * ================================================================== */

  /* A vector is a plain object of term -> weight. Adding text at a
   * weight lets callers say "the name matters three times as much as the
   * sidebar blurb". */
  SubIndex.addText = function (vec, text, weight) {
    const w = weight == null ? 1 : weight;
    for (const terms of SubIndex.tokenizeRuns(text)) {
      for (const t of terms) {
        vec[t] = (vec[t] || 0) + (WEAK.has(t) ? w * WEAK_WEIGHT : w);
      }
      /* Within the clause only, and a phrase is only as weak as its
       * weakest reading. "far right" and "young voter" pair a modifier
       * with a subject and mean something neither half does; "old news"
       * is two nothings in a row. */
      for (const b of SubIndex.bigrams(terms)) {
        vec[b] = (vec[b] || 0) + (SubIndex.isWeak(b) ? w * WEAK_WEIGHT : w * 1.5);
      }
    }
    return vec;
  };

  /* Field weights reflect how reliably each one describes the audience.
   * The display name is the strongest signal (r/MedicareForAll is not
   * ambiguous), the title next, the sidebar blurb last because it is
   * often mostly rules. */
  SubIndex.vectorFor = function (record) {
    if (!record) return {};
    const vec = {};
    SubIndex.addText(vec, record.display_name || "", 3);
    SubIndex.addText(vec, record.title || "", 2);
    SubIndex.addText(vec, record.public_description || "", 1);
    return vec;
  };

  SubIndex.vectorFromText = function (text, weight) {
    return SubIndex.addText({}, text, weight == null ? 1 : weight);
  };

  SubIndex.mass = function (vec) {
    let m = 0;
    for (const k in vec) m += vec[k];
    return m;
  };

  /* Add a passage whose influence is set by the caller rather than by
   * how long it is.
   *
   * addText gives every occurrence the same weight, so a 3,000-word
   * body outvotes an 8-word title forty to one purely on length. That
   * is the wrong reading of a post: the body says more, but it is not
   * forty times more about the subject. Two corrections:
   *
   *   - repetition saturates. The tenth "eviction" says much less than
   *     the first, so counts are damped to 1 + ln(n) before they are
   *     weighed. Otherwise one word hammered through a rant carries the
   *     passage on its own.
   *   - length is then normalised away. Whatever survives is rescaled
   *     so the passage contributes `mass` in total, and a longer body
   *     spreads that same say across more terms rather than shouting. */
  SubIndex.addTextWithMass = function (vec, text, mass) {
    if (!text || !(mass > 0)) return vec;
    const sub = SubIndex.vectorFromText(text, 1);
    let total = 0;
    for (const t in sub) {
      sub[t] = 1 + Math.log(sub[t]);
      total += sub[t];
    }
    if (!total) return vec;
    const k = mass / total;
    for (const t in sub) vec[t] = (vec[t] || 0) + sub[t] * k;
    return vec;
  };

  /* Cosine similarity, with an optional inverse-document-frequency
   * weight so that terms appearing in half the index (e.g. "political")
   * count for less than a term appearing in three subs. */
  SubIndex.cosine = function (a, b, idf) {
    if (!a || !b) return 0;
    let dot = 0, na = 0, nb = 0;
    const weight = (term) => (idf ? (idf[term] || idf.__default || 1) : 1);
    for (const [term, va] of Object.entries(a)) {
      const w = weight(term);
      na += (va * w) * (va * w);
      const vb = b[term];
      if (vb) dot += (va * w) * (vb * w);
    }
    for (const [term, vb] of Object.entries(b)) {
      const w = weight(term);
      nb += (vb * w) * (vb * w);
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  };

  /* Cosine reports how similar two documents are, not whether the
   * similarity is spread across a shared vocabulary or resting on one
   * word. Those are very different kinds of evidence, so callers that
   * act on a similarity need the shape of it too.
   *
   * `count`    how many terms contribute at all
   * `topShare` the fraction of the similarity held by the single
   *            heaviest term — 1.0 means one word is the whole match */
  SubIndex.overlapProfile = function (a, b, idf) {
    const weight = (term) => (idf ? (idf[term] || idf.__default || 1) : 1);
    let total = 0;
    let top = 0;
    let count = 0;
    for (const [term, va] of Object.entries(a || {})) {
      const vb = (b || {})[term];
      if (!vb) continue;
      const w = weight(term);
      const contrib = va * w * vb * w;
      total += contrib;
      if (contrib > top) top = contrib;
      count++;
    }
    return { count: count, total: total, topShare: total > 0 ? top / total : 0 };
  };

  /* The terms two vectors share, strongest first. Used to explain a
   * match in the UI instead of asserting a bare score.
   *
   * Ranked by informativeness, not by how often the word appears. Those
   * came apart badly: the words two documents use most are the words
   * everyone uses, so the explanation for every match was drawn from
   * the same handful of unremarkable words while the terms that
   * actually drove the score sat below the cut. Weighting by the same
   * IDF the score itself uses puts the reason and the score back in
   * agreement. */
  SubIndex.overlapTerms = function (a, b, limit, idf) {
    const weight = (term) => (idf ? (idf[term] || idf.__default || 1) : 1);
    const out = [];
    for (const [term, va] of Object.entries(a || {})) {
      const vb = (b || {})[term];
      if (!vb) continue;
      const w = weight(term);
      out.push({ term: term, weight: va * w * vb * w });
    }
    out.sort((x, y) => y.weight - x.weight);
    return SubIndex.presentable(out, limit || 6);
  };

  /* Turn ranked internal terms into something worth showing a person.
   *
   * Three things are wrong with the raw list. It is in stems, so
   * "organizing" reads as "organiz". It contains weak words, which are
   * near-weightless in the score but can still float to the top of a
   * short list when little else overlaps. And it repeats itself:
   * "organiz", "workplace organiz" and "organiz union" are one idea
   * printed three times, which crowds out the second idea entirely.
   *
   * Phrases win over the words inside them, because a phrase says more
   * and costs the same to read. */
  SubIndex.presentable = function (ranked, limit) {
    const phrases = [];
    const kept = [];
    const covered = new Set();

    for (const item of ranked || []) {
      const term = item.term || item;
      if (term.indexOf(" ") < 0) continue;
      if (SubIndex.isWeak(term)) continue;
      phrases.push(item);
      for (const w of term.split(" ")) covered.add(w);
    }

    for (const item of ranked || []) {
      const term = item.term || item;
      if (SubIndex.isWeak(term)) continue;
      if (term.indexOf(" ") < 0 && covered.has(term)) continue;
      kept.push(item);
      if (kept.length >= (limit || 6)) break;
    }

    return kept.map((item) => (typeof item === "string"
      ? SubIndex.surfaceOf(item)
      : Object.assign({}, item, { term: SubIndex.surfaceOf(item.term) })));
  };

  function countDf(vectors, into) {
    const df = into || {};
    let n = 0;
    for (const vec of vectors || []) {
      if (!vec) continue;
      n++;
      for (const term of Object.keys(vec)) df[term] = (df[term] || 0) + 1;
    }
    return { df: df, n: n };
  }

  function idfFromDf(df, n) {
    const idf = { __default: 1 };
    if (!n) return idf;
    for (const term in df) idf[term] = Math.log(1 + n / df[term]);
    idf.__default = Math.log(1 + n);
    return idf;
  }

  /* Build an IDF table over a collection of vectors. Terms present in
   * many documents get a low weight. */
  SubIndex.buildIdf = function (vectors) {
    const counted = countDf(vectors);
    return idfFromDf(counted.df, counted.n);
  };

  /* ------------------------------------------------------------------
   * HOW COMMON IS THIS WORD, REALLY
   * ------------------------------------------------------------------ */

  /* Rarity was being measured against the wrong thing.
   *
   * buildIdf was only ever handed the forty candidates of the run in
   * progress, and those forty are alike by construction — they were
   * shortlisted for resembling the query. A word every one of them uses
   * looks common and gets discounted; a word specific to the subject
   * they share looks common for exactly the same reason and gets
   * discounted too. With forty documents the whole scale spans a factor
   * of five, so it could not separate much in either direction.
   *
   * The app already holds a real corpus: every subreddit description it
   * has ever cached, plus every post loaded. Hundreds to thousands of
   * documents, spanning subjects rather than one, which is what a
   * statement like "this word is unremarkable" needs to be measured
   * against. Counted once and reused, and pooled with the documents of
   * the run so a term the corpus has never met is still counted rather
   * than treated as unheard-of. */

  /* Below this there is no corpus worth the name, and the local
   * documents are the better estimate. */
  const CORPUS_MIN = 80;
  /* Document frequency is a statistic; a large sample answers it as
   * well as the whole population and does not grow without bound. */
  const CORPUS_POST_CAP = 2500;
  const POST_SCAN = 600;

  let corpusCache = null;
  let corpusKey = "";

  function corpusDf() {
    const posts = (window.AppState && Array.isArray(AppState.posts) ? AppState.posts : []);
    const sample = Math.min(posts.length, CORPUS_POST_CAP);
    const key = mem.size + ":" + sample;
    if (corpusCache && corpusKey === key) return corpusCache;

    const df = {};
    let n = 0;

    for (const record of mem.values()) {
      if (!record.vector) record.vector = SubIndex.vectorFor(record);
      n++;
      for (const term in record.vector) df[term] = (df[term] || 0) + 1;
    }

    for (let i = 0; i < sample; i++) {
      const p = posts[i];
      if (!p) continue;
      const vec = {};
      SubIndex.addText(vec, p.title || "", 1);
      if (p.flair) SubIndex.addText(vec, p.flair, 1);
      if (window.Util && Util.postBody) SubIndex.addText(vec, Util.postBody(p, POST_SCAN), 1);
      n++;
      for (const term in vec) df[term] = (df[term] || 0) + 1;
    }

    corpusCache = n >= CORPUS_MIN ? { df: df, n: n } : null;
    corpusKey = key;
    return corpusCache;
  }

  SubIndex.corpusSize = function () {
    const c = corpusDf();
    return c ? c.n : 0;
  };

  /* The IDF a scorer should use: the corpus if there is one, pooled
   * with the documents of this particular run so nothing goes
   * uncounted. Falls back to exactly the old behaviour when the index
   * is too small to say anything. */
  SubIndex.idfFor = function (vectors) {
    const corpus = corpusDf();
    if (!corpus) return SubIndex.buildIdf(vectors);
    const df = Object.assign({}, corpus.df);
    const local = countDf(vectors, df);
    return idfFromDf(df, corpus.n + local.n);
  };

  /* ==================================================================
   * STORAGE
   * ================================================================== */

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (typeof indexedDB === "undefined") return resolve(null);
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (_) { return resolve(null); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      /* Safari in private mode can hang here rather than erroring. */
      setTimeout(() => resolve(null), 2500);
    });
    return dbPromise;
  }

  function idbAll(db) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (_) {
        resolve([]);
      }
    });
  }

  function idbPut(db, records) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const r of records) store.put(r);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (_) {
        resolve(false);
      }
    });
  }

  function lsLoad() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  let lsSaveTimer = null;
  function lsSaveSoon() {
    if (lsSaveTimer) clearTimeout(lsSaveTimer);
    lsSaveTimer = setTimeout(() => {
      lsSaveTimer = null;
      try {
        const all = Array.from(mem.values())
          .sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0))
          .slice(0, LS_MAX)
          /* Vectors are re-derivable, so they are not persisted. */
          .map((r) => ({
            key: r.key, display_name: r.display_name, title: r.title,
            public_description: r.public_description, subscribers: r.subscribers,
            active_user_count: r.active_user_count, over18: r.over18,
            created_utc: r.created_utc, icon: r.icon, fetchedAt: r.fetchedAt,
          }));
        localStorage.setItem(LS_KEY, JSON.stringify(all));
      } catch (_) {}
    }, 800);
  }

  let pendingWrites = [];
  let writeTimer = null;
  function scheduleWrite(record) {
    pendingWrites.push(record);
    if (writeTimer) return;
    writeTimer = setTimeout(async () => {
      writeTimer = null;
      const batch = pendingWrites;
      pendingWrites = [];
      const db = await openDb();
      if (db) await idbPut(db, batch.map(stripVector));
      else lsSaveSoon();
    }, 400);
  }

  function stripVector(r) {
    const copy = Object.assign({}, r);
    delete copy.vector;
    return copy;
  }

  function fresh(record) {
    return record && record.fetchedAt && Date.now() - record.fetchedAt < TTL_MS;
  }

  SubIndex.load = async function () {
    if (loaded) return mem.size;
    loaded = true;
    let records = [];
    const db = await openDb();
    if (db) records = await idbAll(db);
    if (!records.length) records = lsLoad();
    for (const r of records) {
      if (!r || !r.key) continue;
      mem.set(r.key, r);
    }
    return mem.size;
  };

  /* ==================================================================
   * RECORDS
   * ================================================================== */

  function normalizeName(name) {
    return String(name || "")
      .replace(/^\/?r\//i, "")
      .replace(/\/.*$/, "")
      .trim();
  }

  /* Shape whatever Reddit gave us (search payload or about.json) into a
   * record, and attach its vector. */
  SubIndex.makeRecord = function (raw, opts) {
    if (!raw) return null;
    const name = normalizeName(raw.display_name || raw.name || raw.sub || "");
    if (!name) return null;
    const record = {
      key: name.toLowerCase(),
      display_name: name,
      title: raw.title || "",
      public_description: raw.public_description || raw.description || "",
      subscribers: Number(raw.subscribers) || 0,
      active_user_count: Number(raw.active_user_count || raw.accounts_active) || 0,
      over18: !!raw.over18,
      created_utc: Number(raw.created_utc) || 0,
      icon: raw.icon_img || raw.community_icon || raw.icon || "",
      fetchedAt: (opts && opts.fetchedAt) || Date.now(),
      /* `partial` marks a record built from a search payload rather than
       * about.json. Both carry a description, but about.json is
       * authoritative and includes subscriber counts for private subs. */
      partial: !!(opts && opts.partial),
    };
    record.vector = SubIndex.vectorFor(record);
    return record;
  };

  SubIndex.put = function (raw, opts) {
    const record = SubIndex.makeRecord(raw, opts);
    if (!record) return null;
    const existing = mem.get(record.key);
    /* Never let a thin search payload overwrite a full about.json record
     * that is still fresh. */
    if (existing && !existing.partial && record.partial && fresh(existing)) return existing;
    mem.set(record.key, record);
    scheduleWrite(record);
    return record;
  };

  SubIndex.get = function (name) {
    const key = normalizeName(name).toLowerCase();
    const record = mem.get(key);
    if (!record) return null;
    if (!record.vector) record.vector = SubIndex.vectorFor(record);
    return record;
  };

  SubIndex.has = function (name) {
    return mem.has(normalizeName(name).toLowerCase());
  };

  SubIndex.all = function () {
    const out = [];
    for (const record of mem.values()) {
      if (!record.vector) record.vector = SubIndex.vectorFor(record);
      out.push(record);
    }
    return out;
  };

  SubIndex.size = function () {
    return mem.size;
  };

  /* Fetch about.json for any name we do not already hold a fresh record
   * for. `opts.onProgress(done, total, name)` reports as they land.
   * Returns records for every requested name that resolved. */
  SubIndex.ensure = async function (names, opts) {
    opts = opts || {};
    await SubIndex.load();

    const wanted = [];
    const seen = new Set();
    for (const raw of names || []) {
      const name = normalizeName(raw);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      wanted.push(name);
    }

    const missing = wanted.filter((n) => {
      const record = mem.get(n.toLowerCase());
      return !(record && fresh(record) && !record.partial);
    });

    const budget = opts.limit == null ? missing.length : Math.min(missing.length, opts.limit);
    const toFetch = missing.slice(0, budget);

    if (toFetch.length && window.Reddit && window.Util) {
      let done = 0;
      await Util.pmap(toFetch, opts.concurrency || 3, async (name) => {
        try {
          const about = await Reddit.fetchSubredditAbout(name);
          if (about && about.display_name) SubIndex.put(about);
        } catch (_) {
          /* Private, banned, or not in the archive. Leave it out rather
           * than caching a hole. */
        } finally {
          done++;
          if (typeof opts.onProgress === "function") opts.onProgress(done, toFetch.length, name);
        }
      });
    }

    return wanted.map((n) => SubIndex.get(n)).filter(Boolean);
  };

  /* Nearest neighbours by description-vector cosine, restricted to what
   * is already in the index. Cheap and offline. */
  SubIndex.nearest = function (vector, opts) {
    opts = opts || {};
    const exclude = new Set((opts.exclude || []).map((s) => String(s).toLowerCase()));
    const records = SubIndex.all().filter((r) => !exclude.has(r.key));
    const idf = opts.idf || SubIndex.idfFor(records.map((r) => r.vector));
    const scored = [];
    for (const record of records) {
      const score = SubIndex.cosine(vector, record.vector, idf);
      if (score <= (opts.minScore == null ? 0.02 : opts.minScore)) continue;
      scored.push({ record: record, score: score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.limit || 12);
  };

  /* Offline search over the cache, so the box paints something useful
   * before the network answers — and stays useful when it never does.
   *
   * Name matching alone only answers "what is this sub called", which
   * fails the moment someone types what they care about rather than who
   * they want: "labor union" matches no subreddit name. So exact and
   * prefix name hits come first, then anything the descriptions say is
   * about the same subject. */
  SubIndex.searchLocal = function (query, limit) {
    const raw = String(query || "").trim();
    if (!raw) return [];
    const cap = limit || 10;

    const q = normalizeName(raw).toLowerCase();
    const starts = [];
    const contains = [];
    const seen = new Set();
    for (const record of mem.values()) {
      const key = record.key;
      if (key === q) starts.unshift(record);
      else if (key.startsWith(q)) starts.push(record);
      else if (key.includes(q) || (record.title || "").toLowerCase().includes(q)) contains.push(record);
      else continue;
      seen.add(key);
    }
    const bySubs = (a, b) => (b.subscribers || 0) - (a.subscribers || 0);
    starts.sort(bySubs);
    contains.sort(bySubs);

    const out = starts.concat(contains);
    if (out.length >= cap) return out.slice(0, cap);

    for (const hit of SubIndex.nearest(SubIndex.vectorFromText(raw, 1), { limit: cap, minScore: 0.05 })) {
      if (seen.has(hit.record.key)) continue;
      seen.add(hit.record.key);
      out.push(hit.record);
    }
    return out.slice(0, cap);
  };

  SubIndex.clear = async function () {
    mem.clear();
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
    const db = await openDb();
    if (!db) return;
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
    } catch (_) {}
  };

  window.SubIndex = SubIndex;
})();
