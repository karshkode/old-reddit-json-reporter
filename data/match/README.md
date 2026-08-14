# Match lexicons (daily updates)

These JSON files drive Discovery / Syndicate destination ranking. Edit them in small PRs; the hardcoded tables in `js/seeds.js` and `js/discovery.js` remain as offline fallbacks until the files load.

## Files

| File | Purpose |
|---|---|
| `sphere-triggers.json` | Issue + demographic trigger phrases (sphere vectors) |
| `offtopic-terms.json` | Entertainment / gaming / recipe noise for community descriptions |
| `source-tiers.json` | Preferred vs hostile news hosts (ranking boost/penalty only) |
| `topic-seeds.json` | Which spheres to seed for syndicated headlines |
| `fixtures/headlines.json` | Regression headlines for the agent loop |
| `version.json` | Bump `version` + `notes` on every lexicon PR |

Sphere **membership** (which subs belong to an issue) still lives in `js/seeds.js` — add public, alive, ≥1k-subscriber communities there when expanding the catalog.

## Agent checklist (daily)

1. Reproduce a bad suggestion (headline → wrong `r/…`), or run the fixture loop:
   ```bash
   node scripts/propose-lexicon-update.mjs
   ```
2. Open `data/match/proposals/YYYYMMDD.json`. Decide whether each proposed phrase belongs in triggers, sphere membership, offtopic, source tier, or topic-seeds.
3. Prefer **multi-word phrases** over bare common words (`food stamp`, not `food`).
4. Put each phrase in **one** sphere — overlap drags campaigns sideways.
5. Apply accepted edits to the JSON (never merge the raw proposals dump).
6. Bump `version.json` (`version`, `updated`, short `notes`).
7. Smoke-test five headlines in Syndicate (Pull → Suggest): food recall, election lawsuit, labor win, climate EPA, random sports/celebrity should stay weak or empty.
8. Open a PR titled like `matchlex: …` with the JSON diff and the five test lines in the body.

## Scoring extras (runtime, not JSON)

- **Link engagement prior** — similar link posts in a candidate sub (loaded inventory, plus a light archive sample on live match) nudge `scoreCandidate`.
- **Entity expansion** — bill numbers, civic acronyms, and Title-Case phrases widen the offline candidate pool via `SubIndex.searchLocal`.

## Loading

`js/matchlex.js` fetches these files once on boot, merges into Seeds / Discovery, and calls `Discovery.invalidateSpheres()`. No rebuild required for GitHub Pages beyond merging the PR.
