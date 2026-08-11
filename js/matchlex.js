/* =====================================================================
 * MATCH LEXICONS
 * ---------------------------------------------------------------------
 * Versioned JSON under data/match/ that Discovery and Seeds overlay at
 * runtime. Hardcoded tables stay as fallbacks until fetch succeeds, so
 * file:// and offline still work. Daily agent PRs edit the JSON; bump
 * data/match/version.json when they do. See data/match/README.md.
 * ===================================================================== */
(function () {
  "use strict";

  const MatchLex = {};
  const BASE = "./data/match/";

  let ready = false;
  let loading = null;
  let version = null;

  MatchLex.topicSeeds = {
    minAbsolute: 0.035,
    bySphere: {},
    fallback: ["media_news"],
  };

  const tiers = {
    preferred: new Set(),
    hostile: new Set(),
    boost: 0.04,
    penalty: 0.05,
  };

  MatchLex.ready = function () { return ready; };
  MatchLex.version = function () { return version; };

  function hostKey(host) {
    let h = String(host || "").toLowerCase().trim();
    if (h.indexOf("www.") === 0) h = h.slice(4);
    return h;
  }

  MatchLex.sourceTier = function (host) {
    const h = hostKey(host);
    if (!h) return "neutral";
    if (tiers.preferred.has(h)) return "preferred";
    if (tiers.hostile.has(h)) return "hostile";
    return "neutral";
  };

  MatchLex.sourceBoost = function (host) {
    const kind = MatchLex.sourceTier(host);
    if (kind === "preferred") return tiers.boost;
    if (kind === "hostile") return -tiers.penalty;
    return 0;
  };

  async function fetchJson(name) {
    const res = await fetch(BASE + name, { credentials: "omit", cache: "no-cache" });
    if (!res.ok) throw new Error(name + " HTTP " + res.status);
    return res.json();
  }

  function applyTriggers(data) {
    if (!window.Seeds || !data) return;
    if (data.issue && typeof data.issue === "object") {
      Seeds.SPHERE_TRIGGERS = Object.assign({}, Seeds.SPHERE_TRIGGERS || {}, data.issue);
    }
    if (data.demographic && typeof data.demographic === "object") {
      Seeds.DEMOGRAPHIC_TRIGGERS = Object.assign({}, Seeds.DEMOGRAPHIC_TRIGGERS || {}, data.demographic);
    }
  }

  function applyOfftopic(data) {
    if (!window.Discovery || !data || !Array.isArray(data.terms)) return;
    if (typeof Discovery.setOfftopicTerms === "function") {
      Discovery.setOfftopicTerms(data.terms);
    }
  }

  function applySourceTiers(data) {
    if (!data) return;
    tiers.preferred = new Set((data.preferred || []).map(hostKey));
    tiers.hostile = new Set((data.hostile || []).map(hostKey));
    if (data.boost != null) tiers.boost = Number(data.boost) || 0.04;
    if (data.penalty != null) tiers.penalty = Number(data.penalty) || 0.05;
  }

  function applyTopicSeeds(data) {
    if (!data) return;
    MatchLex.topicSeeds = {
      minAbsolute: data.minAbsolute == null ? 0.035 : Number(data.minAbsolute),
      bySphere: data.bySphere || {},
      fallback: Array.isArray(data.fallback) && data.fallback.length ? data.fallback.slice() : ["media_news"],
    };
  }

  /* Which issue spheres to dump into a syndicated article's candidate
   * pool, given the spheres Discovery already ranked for its text. */
  MatchLex.seedKeysFor = function (rankedSpheres) {
    const cfg = MatchLex.topicSeeds;
    const floor = cfg.minAbsolute == null ? 0.035 : cfg.minAbsolute;
    const keys = [];
    const seen = new Set();
    for (const s of rankedSpheres || []) {
      if (!s || !s.key) continue;
      if ((s.score || 0) < floor) continue;
      const extras = cfg.bySphere[s.key] || [s.key];
      for (const k of extras) {
        if (seen.has(k)) continue;
        seen.add(k);
        keys.push(k);
      }
    }
    if (!keys.length) {
      for (const k of cfg.fallback) {
        if (!seen.has(k)) { seen.add(k); keys.push(k); }
      }
    }
    return keys;
  };

  MatchLex.load = async function () {
    if (ready) return { ok: true, version: version };
    if (loading) return loading;
    loading = (async () => {
      try {
        const [ver, triggers, offtopic, sources, topics] = await Promise.all([
          fetchJson("version.json").catch(() => null),
          fetchJson("sphere-triggers.json").catch(() => null),
          fetchJson("offtopic-terms.json").catch(() => null),
          fetchJson("source-tiers.json").catch(() => null),
          fetchJson("topic-seeds.json").catch(() => null),
        ]);
        if (ver) version = ver;
        applyTriggers(triggers);
        applyOfftopic(offtopic);
        applySourceTiers(sources);
        applyTopicSeeds(topics);
        if (window.Seeds && typeof Seeds.invalidateIndex === "function") Seeds.invalidateIndex();
        if (window.Discovery && typeof Discovery.invalidateSpheres === "function") {
          Discovery.invalidateSpheres();
        }
        ready = true;
        console.log("[matchlex] loaded", version && version.version ? version.version : "ok");
        return { ok: true, version: version };
      } catch (err) {
        console.warn("[matchlex] load failed; using hardcoded fallbacks:", err && err.message);
        ready = true;
        return { ok: false, error: err };
      } finally {
        loading = null;
      }
    })();
    return loading;
  };

  window.MatchLex = MatchLex;
})();
