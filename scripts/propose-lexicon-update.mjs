#!/usr/bin/env node
/**
 * Daily lexicon helper for data/match/.
 *
 * Loads fixture headlines + current sphere-triggers.json, checks which
 * expected spheres already contain overlapping phrases, and proposes
 * multi-word trigger additions for gaps. Does not apply patches — write
 * a PR after review.
 *
 * Usage:
 *   node scripts/propose-lexicon-update.mjs
 *   node scripts/propose-lexicon-update.mjs --apply-notes
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MATCH = path.join(ROOT, "data", "match");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(MATCH, name), "utf8"));
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phrasesFrom(text) {
  const words = normalize(text).split(" ").filter((w) => w.length >= 3);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i].length >= 5) out.push(words[i]);
    if (i + 1 < words.length) out.push(`${words[i]} ${words[i + 1]}`);
    if (i + 2 < words.length) out.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  /* Prefer longer phrases — bare common words are how spheres leak. */
  return Array.from(new Set(out)).sort((a, b) => b.split(" ").length - a.split(" ").length || b.length - a.length);
}

function asWords(s) {
  return normalize(s).split(" ").filter(Boolean);
}

/* Whole-token overlap only — never substring ("layoff" ⊂ "playoffs"). */
function sphereHasPhrase(triggers, phrase) {
  const pWords = asWords(phrase);
  if (!pWords.length) return false;
  const p = pWords.join(" ");
  for (const t of triggers || []) {
    const tWords = asWords(t);
    if (!tWords.length) continue;
    const n = tWords.join(" ");
    if (n === p) return true;
    /* Multi-word trigger fully inside the candidate phrase, or vice versa. */
    if (tWords.length >= 2 && (` ${p} `).includes(` ${n} `)) return true;
    if (pWords.length >= 2 && (` ${n} `).includes(` ${p} `)) return true;
    /* Single-token: exact token match only when both sides are one word,
     * or the token appears as a full word in a multi-word peer. */
    if (tWords.length === 1 && pWords.length === 1 && tWords[0] === pWords[0]) return true;
    if (tWords.length === 1 && pWords.length > 1 && pWords.includes(tWords[0]) && tWords[0].length >= 5) return true;
    if (pWords.length === 1 && tWords.length > 1 && tWords.includes(pWords[0]) && pWords[0].length >= 5) return true;
  }
  return false;
}

function scoreFixture(fixture, issueTriggers) {
  const blob = `${fixture.title || ""} ${fixture.summary || ""}`;
  const phrases = phrasesFrom(blob);
  const hits = {};
  for (const [sphere, triggers] of Object.entries(issueTriggers)) {
    let n = 0;
    const matched = [];
    for (const ph of phrases) {
      if (sphereHasPhrase(triggers, ph)) {
        n++;
        matched.push(ph);
      }
    }
    hits[sphere] = { n, matched: matched.slice(0, 8) };
  }
  const ranked = Object.entries(hits)
    .filter(([, v]) => v.n > 0)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => ({ sphere: k, n: v.n, matched: v.matched }));

  const expect = fixture.expectSpheres || [];
  const avoid = fixture.avoidSpheres || [];
  const top = ranked[0] && ranked[0].sphere;
  const okExpect = !expect.length || expect.some((s) => ranked.some((r) => r.sphere === s && r.n > 0));
  const okAvoid = !avoid.length || !avoid.some((s) => {
    const hit = ranked.find((r) => r.sphere === s);
    return hit && hit.n >= 2 && ranked[0] && ranked[0].sphere === s;
  });
  /* Noise headlines: entertainment/sports should not crown a campaign
   * sphere. media_news hits on "social media" etc. are ignored. */
  const CIVIC_CROWN = new Set([
    "progressive", "democracy", "voting", "labor", "movement", "election_law",
    "immigration", "healthcare", "climate", "safety_net", "racial_justice",
    "reproductive", "consumer_protection", "gun_violence", "criminal_justice",
  ]);
  const noiseOk = expect.length === 0
    ? (!ranked.length || !CIVIC_CROWN.has(ranked[0].sphere) || ranked[0].n < 2)
    : true;

  const titleNorm = ` ${normalize(fixture.title || "")} `;
  const triggerTokens = new Set();
  for (const sphere of expect) {
    for (const t of issueTriggers[sphere] || []) {
      for (const w of asWords(t)) if (w.length >= 4) triggerTokens.add(w);
    }
  }

  const proposals = [];
  for (const sphere of expect) {
    const triggers = issueTriggers[sphere] || [];
    for (const ph of phrases) {
      const words = asWords(ph);
      if (words.length < 2) continue; /* multi-word only */
      if (!titleNorm.includes(` ${words.join(" ")} `)) continue; /* title-contiguous */
      if (!words.some((w) => w.length >= 5)) continue;
      /* Prefer phrases that already share a token with the sphere. */
      if (triggerTokens.size && !words.some((w) => triggerTokens.has(w))) continue;
      if (sphereHasPhrase(triggers, ph)) continue;
      let owned = false;
      for (const [other, list] of Object.entries(issueTriggers)) {
        if (other === sphere) continue;
        if (sphereHasPhrase(list, ph)) { owned = true; break; }
      }
      if (owned) continue;
      proposals.push({ sphere, phrase: ph, from: fixture.id });
    }
  }

  return {
    id: fixture.id,
    title: fixture.title,
    ok: okExpect && okAvoid && noiseOk,
    okExpect,
    okAvoid,
    noiseOk,
    ranked: ranked.slice(0, 5),
    proposals: proposals.slice(0, 6),
  };
}

function main() {
  const fixtures = readJson("fixtures/headlines.json");
  const triggersDoc = readJson("sphere-triggers.json");
  const version = readJson("version.json");
  const issue = triggersDoc.issue || {};

  const results = fixtures.map((f) => scoreFixture(f, issue));
  const failed = results.filter((r) => !r.ok);
  const proposalMap = new Map();
  for (const r of results) {
    for (const p of r.proposals) {
      const key = `${p.sphere}::${p.phrase}`;
      if (!proposalMap.has(key)) proposalMap.set(key, p);
    }
  }
  const proposals = Array.from(proposalMap.values());

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const outDir = path.join(MATCH, "proposals");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${stamp}.json`);
  const payload = {
    generated: new Date().toISOString(),
    lexiconVersion: version.version,
    fixturePass: results.length - failed.length,
    fixtureTotal: results.length,
    failed: failed.map((f) => f.id),
    results,
    proposedAdditions: proposals,
    notes: "Review multi-word phrases; add only those that uniquely identify the sphere. Prefer editing sphere-triggers.json by hand, then bump version.json.",
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");

  console.log(`Fixtures: ${payload.fixturePass}/${payload.fixtureTotal} pass`);
  for (const r of results) {
    const top = r.ranked[0] ? `${r.ranked[0].sphere}×${r.ranked[0].n}` : "none";
    console.log(`  ${r.ok ? "OK" : "!!"} ${r.id} → ${top}`);
  }
  console.log(`Proposals: ${proposals.length} (wrote ${path.relative(ROOT, outPath)})`);
  for (const p of proposals.slice(0, 20)) {
    console.log(`  + ${p.sphere}: "${p.phrase}" (${p.from})`);
  }

  if (process.argv.includes("--apply-notes")) {
    const nextNotes = `Agent loop ${stamp}: ${payload.fixturePass}/${payload.fixtureTotal} fixtures; ${proposals.length} proposed phrases pending review.`;
    version.notes = nextNotes;
    version.updated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(MATCH, "version.json"), JSON.stringify(version, null, 2) + "\n");
    console.log("Updated version.json notes (version number unchanged — bump when merging lexicon edits).");
  }

  if (failed.length) process.exitCode = 1;
}

main();
