#!/usr/bin/env node
/* Fail when a shipped asset changed but its ?v= stamp did not.
 *
 * index.html is the manifest: the service worker keys its cache on the
 * full asset URL, query string included, so an edited stylesheet that
 * keeps its old stamp is a cache hit forever. Returning visitors then
 * run the new markup against the previous release's CSS, which is how
 * the action bar came apart on iOS in August 2026 — the markup grew a
 * wrapper element the cached stylesheet had never heard of.
 *
 * Nothing about that failure is visible to whoever shipped it. Their
 * own browser had no prior cache entry, so the bug only exists for
 * people who visited before. Hence this check.
 *
 *   node tools/stampcheck.js [baseRef]     default: origin/main
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = "index.html";
const VERSIONED = /^(css|js|vendor)\/.+\.(css|js)$/;

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/* path -> stamp, for every css/js index.html asks the browser to load. */
function stamps(html) {
  const out = new Map();
  const re = /(?:src|href)\s*=\s*"\.\/([^"?]+\.(?:css|js))(\?[^"]*)?"/gi;
  let m;
  while ((m = re.exec(html))) {
    const q = new URLSearchParams((m[2] || "").replace(/^\?/, ""));
    out.set(m[1], q.get("v"));
  }
  return out;
}

const problems = [];
const head = stamps(fs.readFileSync(path.join(ROOT, MANIFEST), "utf8"));

/* 1. Every asset must carry a stamp at all. Without one the worker
 *    falls back to stale-while-revalidate, which serves the old bytes
 *    once more before it catches up. */
for (const [file, v] of head) {
  if (!v) problems.push(`${file} is loaded without a ?v= stamp`);
}

/* 2. One release, one stamp. Per-file stamps would work, but the
 *    convention here is uniform, and a stray value is a typo. */
const distinct = new Set(Array.from(head.values()).filter(Boolean));
if (distinct.size > 1) {
  const groups = new Map();
  for (const [file, v] of head) {
    if (!v) continue;
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(file);
  }
  const odd = Array.from(groups.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(1)
    .map(([v, files]) => `${v} (${files.join(", ")})`);
  problems.push(`mixed stamps in ${MANIFEST}: majority is ` +
    `${Array.from(groups.keys())[0]}, but also ${odd.join("; ")}`);
}

/* 3. The load-bearing one: changed bytes demand a changed stamp. */
const base = process.argv[2] || "origin/main";
let baseHtml = null;
try {
  baseHtml = git("show", `${base}:${MANIFEST}`);
} catch (_) {
  console.log(`stampcheck: no ${base} to compare against, ` +
    `checked ${head.size} assets for stamps only`);
}

if (baseHtml !== null) {
  const before = stamps(baseHtml);
  /* Against the merge base with no second ref, so the working tree
   * counts. Comparing committed trees only would let the check pass
   * right up until the moment it stopped mattering. */
  const fork = git("merge-base", base, "HEAD");
  const changed = Array.from(new Set([
    ...git("diff", "--name-only", fork).split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").split("\n"),
  ])).filter((f) => f && VERSIONED.test(f) && head.has(f));

  const unbumped = changed.filter((f) => before.has(f) && before.get(f) === head.get(f));
  if (unbumped.length) {
    problems.push(
      `changed since ${base} but still served under the same ?v=` +
      `${head.get(unbumped[0])}:\n    ${unbumped.join("\n    ")}\n` +
      `  Anyone who loaded the site before will keep the old copy of ` +
      `these.\n  Bump the ?v= on every asset in ${MANIFEST}.`);
  }
}

if (problems.length) {
  console.error("stampcheck: " + problems.length + " problem" +
    (problems.length === 1 ? "" : "s") + "\n");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`stampcheck: ok — ${head.size} assets, stamp ` +
  `${Array.from(distinct)[0] || "n/a"}`);
