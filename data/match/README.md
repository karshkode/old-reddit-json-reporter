# Match lexicons (daily updates)

These JSON files drive Discovery / Syndicate destination ranking for the progressive desk. Edit them in small PRs; the hardcoded tables in `js/seeds.js` and `js/discovery.js` remain as offline fallbacks until the files load.

## Files

| File | Purpose |
|---|---|
| `sphere-triggers.json` | Issue + demographic trigger phrases (sphere vectors) |
| `offtopic-terms.json` | Entertainment / gaming / recipe noise for community descriptions |
| `source-tiers.json` | Preferred vs hostile news hosts (ranking boost/penalty only) |
| `topic-seeds.json` | Which spheres to seed for syndicated headlines |
| `version.json` | Bump `version` + `notes` on every lexicon PR |

Sphere **membership** (which subs belong to an issue) still lives in `js/seeds.js` — add public, alive, ≥1k-subscriber communities there when expanding the catalog.

## Agent checklist

1. Reproduce a bad suggestion (headline → wrong `r/…`).
2. Decide whether the fix is: triggers, sphere membership, offtopic term, source tier, or topic-seed map.
3. Prefer **multi-word phrases** over bare common words (`food stamp`, not `food`).
4. Put each phrase in **one** sphere — overlap drags campaigns sideways.
5. Bump `version.json` (`version`, `updated`, short `notes`).
6. Smoke-test five headlines in Syndicate (Pull → Suggest): food recall, election lawsuit, labor win, climate EPA, random sports/celebrity should stay weak or empty.
7. Open a PR titled like `matchlex: …` with the JSON diff and the five test lines in the body.

## Loading

`js/matchlex.js` fetches these files once on boot, merges into Seeds / Discovery, and calls `Discovery.invalidateSpheres()`. No rebuild required for GitHub Pages beyond merging the PR.
