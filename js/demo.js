/* =====================================================================
 * DEMO MODE
 * ---------------------------------------------------------------------
 * A bundled fixture dataset, activated with `?demo=1`.
 *
 * Reddit blocks anonymous browser CORS, so the app depends on public
 * proxies that periodically stop working all at once. When that happens
 * a first-time visitor lands on an empty dashboard with an error and no
 * way to tell whether the tool is any good. Demo mode gives them a fully
 * populated dashboard to explore — and gives the project a deterministic
 * dataset to test every view against.
 *
 * Posts are generated from a fixed seed, so the same URL always produces
 * the same numbers. Nothing is written to localStorage or the post cache:
 * demo state lives in memory for the session only.
 * ===================================================================== */
(function () {
  const Demo = {};

  /* Mulberry32 — small, fast, and deterministic across engines. */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SUBS = [
    { name: "WorkReform", subs: 780000, weight: 1.0, tone: "labor" },
    { name: "MedicareForAll", subs: 62000, weight: 0.7, tone: "healthcare" },
    { name: "Political_Revolution", subs: 210000, weight: 0.8, tone: "progressive" },
    { name: "antiwork", subs: 2800000, weight: 1.2, tone: "labor" },
    { name: "climate", subs: 190000, weight: 0.6, tone: "climate" },
    { name: "Tenants", subs: 28000, weight: 0.4, tone: "housing" },
    { name: "VotingRights", subs: 41000, weight: 0.45, tone: "voting" },
    { name: "GreenNewDeal", subs: 33000, weight: 0.4, tone: "climate" },
    { name: "Unions", subs: 96000, weight: 0.55, tone: "labor" },
    { name: "ProgressivePolitics", subs: 58000, weight: 0.5, tone: "progressive" },
    { name: "Anti_Eviction", subs: 12000, weight: 0.25, tone: "housing" },
    { name: "publichealth", subs: 74000, weight: 0.35, tone: "healthcare" },
  ];

  const TITLES = {
    labor: [
      "Warehouse workers at the Springfield facility just filed for a union election",
      "My employer scheduled a 'mandatory optional' meeting about the union drive",
      "Four-day week trial results are in and productivity went up 8%",
      "The company raised the CEO's pay 32% the same week they froze ours",
      "How do I organize a shop of 14 people without getting fired?",
      "We won. First contract ratified after 19 months of bargaining",
      "Reminder: talking about your pay with coworkers is federally protected",
      "Third shift walked out this morning over the new attendance policy",
      "Started a strike fund for our local, here's the spreadsheet template",
      "Management brought in a union-busting consultancy at $3,200 a day",
    ],
    healthcare: [
      "My insurer denied the same claim four times before approving it",
      "Single-payer polling is at 63% support and still nobody will move a bill",
      "Hospital billed me $1,400 for a room I was in for 40 minutes",
      "Nurses at three county hospitals are voting to authorize a strike",
      "What actually happens to premiums under a public option?",
      "The pharmacy told me the cash price was cheaper than my copay",
      "Medicare negotiation list expanded to 15 more drugs today",
      "Rural clinic closures mapped against state expansion decisions",
    ],
    progressive: [
      "Turnout in the special election beat the last midterm by 11 points",
      "We knocked 4,000 doors this weekend. Here's what we heard",
      "The city council voted 7-2 to fund the participatory budget",
      "Primary challenger just outraised the incumbent two to one",
      "Why down-ballot races decide more of your life than the presidency",
      "Our county party finally adopted small-dollar-only fundraising",
      "State legislature passed the bill nobody thought had a chance",
    ],
    climate: [
      "Solar is now the cheapest new generation in 42 states",
      "The utility spent $12M lobbying against rooftop net metering",
      "Our town just passed a building electrification ordinance",
      "Heat pump rebates are live and the paperwork is genuinely easy",
      "Grid interconnection queue is the real bottleneck, not permits",
      "Community solar co-op hit its subscriber target in six weeks",
    ],
    housing: [
      "Landlord raised rent 40% two weeks after the inspection",
      "Tenant union blocked a mass no-fault eviction in our building",
      "Zoning reform passed and three infill projects filed the same month",
      "What rights do I actually have when repairs are ignored for months?",
      "Our city's vacancy rate is 0.8% and they approved another hotel",
    ],
    voting: [
      "Polling place consolidation cut 40% of sites in the county",
      "Mail ballot rejection rates by county, mapped",
      "Same-day registration passed and turnout jumped 9 points",
      "Volunteer poll workers needed — the training is two hours",
      "The signature-match law is rejecting ballots from young voters 4x more",
    ],
  };

  const FLAIRS = {
    labor: ["Organizing", "Win", "Question", "News"],
    healthcare: ["Policy", "Personal", "News"],
    progressive: ["Electoral", "Organizing", "Discussion"],
    climate: ["Policy", "Local", "Data"],
    housing: ["Tenant Rights", "Local", "Question"],
    voting: ["Access", "Data", "Volunteer"],
  };

  const AUTHORS = [
    "shopsteward_44", "unionmaid", "policywonkette", "third_shift", "quietorganizer",
    "localdem", "canvasser_pdx", "tenant_council", "rn_nightshift", "gridnerd",
    "doorknocker", "grievance_chair", "ballot_curious", "heatpumpguy", "renter_rights",
  ];

  Demo.buildPosts = function (opts) {
    opts = opts || {};
    const rand = rng(opts.seed || 20260726);
    const now = Math.floor(Date.now() / 1000);
    const days = opts.days || 30;
    const posts = [];
    let n = 0;

    for (const sub of SUBS) {
      const count = Math.round(10 + rand() * 14 * sub.weight);
      const titles = TITLES[sub.tone];
      const flairs = FLAIRS[sub.tone];
      for (let i = 0; i < count; i++) {
        /* Bias submissions toward mid-morning and early evening, which
         * is what real civic subreddits look like. */
        const hourBias = rand() < 0.55 ? 9 + Math.floor(rand() * 4) : 17 + Math.floor(rand() * 5);
        const dayOffset = Math.floor(rand() * days);
        const created = now - dayOffset * 86400 - (23 - hourBias) * 3600 - Math.floor(rand() * 3600);

        /* Long-tail score distribution: most posts modest, a few break out. */
        const base = 20 + rand() * 240 * sub.weight;
        const breakout = rand() < 0.08 ? 6 + rand() * 18 : 1;
        const recency = 1 + (1 - dayOffset / days) * 0.4;
        const score = Math.round(base * breakout * recency);

        const commentRate = 0.05 + rand() * 0.22;
        const comments = Math.max(0, Math.round(score * commentRate));
        const ratio = Math.max(0.5, Math.min(0.99, 0.94 - rand() * 0.28 + (breakout > 1 ? 0.03 : 0)));

        const title = titles[Math.floor(rand() * titles.length)];
        posts.push({
          id: "demo" + (++n).toString(36).padStart(4, "0"),
          subreddit: sub.name,
          title: title,
          author: AUTHORS[Math.floor(rand() * AUTHORS.length)],
          score: score,
          num_comments: comments,
          upvote_ratio: Math.round(ratio * 100) / 100,
          created_utc: created,
          permalink: `https://www.reddit.com/r/${sub.name}/comments/demo${n}/`,
          url: `https://www.reddit.com/r/${sub.name}/comments/demo${n}/`,
          flair: rand() < 0.6 ? flairs[Math.floor(rand() * flairs.length)] : "",
          over_18: false,
          stickied: false,
          is_self: rand() < 0.7,
          thumbnail: "",
          total_awards_received: 0,
          view_count: null,
          domain: "self." + sub.name,
        });
      }
    }

    /* A handful of deliberate cross-posts so the cross-post detector and
     * the campaign workspace both have something real to show. */
    const shared = [
      { title: "We won. First contract ratified after 19 months of bargaining", subs: ["WorkReform", "antiwork", "Unions", "Political_Revolution"] },
      { title: "Single-payer polling is at 63% support and still nobody will move a bill", subs: ["MedicareForAll", "publichealth", "ProgressivePolitics"] },
    ];
    for (const group of shared) {
      const t0 = now - Math.floor(3 + rand() * 6) * 86400;
      group.ids = [];
      group.subs.forEach((subName, idx) => {
        const id = "demoX" + (++n).toString(36);
        group.ids.push(id);
        const score = Math.round((900 + rand() * 2600) / (idx * 0.5 + 1));
        posts.push({
          id: id,
          subreddit: subName,
          title: group.title,
          author: "quietorganizer",
          score: score,
          num_comments: Math.round(score * (0.08 + rand() * 0.14)),
          upvote_ratio: Math.round((0.88 - idx * 0.04) * 100) / 100,
          created_utc: t0 + idx * 5400,
          permalink: `https://www.reddit.com/r/${subName}/comments/${id}/`,
          url: `https://www.reddit.com/r/${subName}/comments/${id}/`,
          flair: "Win",
          over_18: false,
          stickied: false,
          is_self: true,
          thumbnail: "",
          total_awards_received: 0,
          view_count: null,
          domain: "self." + subName,
        });
      });
    }

    Demo.crossPostGroups = shared;
    return posts;
  };

  /* Synthetic comments for the detail pane. Demo mode makes no network
   * calls, so without these the detail pane — and the sphere match that
   * hangs off it — is the one surface a demo visitor cannot see. Seeded
   * off the post id so the same post always reads the same way. */
  Demo.detailFor = function (post) {
    if (!post) return null;
    const bodies = [
      "This is exactly the kind of organizing that works. Sharing with my local chapter tonight.",
      "Genuine question — how did you handle the pushback from management? We hit a wall at that stage.",
      "The numbers here are the part people miss. Turnout is downstream of contact, every time.",
      "I would be careful about the framing. It reads well here but it will not travel to a general audience.",
      "We ran something close to this two counties over and got about half the response rate. Location matters.",
      "Saved. If anyone has a template for the outreach script I would take it.",
      "Not convinced this scales, but I would rather be wrong about that than not try.",
      "Cross-posted to a couple of related subs — hope that is alright.",
    ];
    let seed = 0;
    for (const ch of String(post.id)) seed = (seed * 31 + ch.charCodeAt(0)) % 100003;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

    const count = 4 + Math.floor(rand() * 5);
    const comments = [];
    for (let i = 0; i < count; i++) {
      comments.push({
        id: `${post.id}-c${i}`,
        author: `demo_user_${Math.floor(rand() * 900) + 100}`,
        body: bodies[Math.floor(rand() * bodies.length)],
        score: Math.max(1, Math.round(post.score * (0.002 + rand() * 0.03))),
        replies: Math.floor(rand() * 4),
        created_utc: post.created_utc + Math.floor(rand() * 7200) + 600,
      });
    }
    comments.sort((a, b) => b.score - a.score);
    return { post: post, comments: comments };
  };

  Demo.isActive = function () {
    try {
      return new URLSearchParams(window.location.search).get("demo") === "1";
    } catch (_) {
      return false;
    }
  };

  /* Load fixtures into the running app. Deliberately bypasses
   * AppState.persist and PostCache so a demo session leaves no trace on
   * the visitor's device. */
  Demo.activate = function () {
    const posts = Demo.buildPosts();

    AppState.knownSubs = SUBS.map((s) => s.name);
    AppState.activeSubs = new Set(AppState.knownSubs);
    AppState.posts = posts;
    AppState.pendingChanges = false;

    /* Seed the subreddit index so the catalog, discovery and similarity
     * search all have descriptions to work with offline. */
    for (const sub of SUBS) {
      SubIndex.put({
        display_name: sub.name,
        title: sub.name,
        public_description: describe(sub),
        subscribers: sub.subs,
        active_user_count: Math.round(sub.subs * 0.004),
        created_utc: Math.floor(Date.now() / 1000) - 86400 * 2000,
      }, { partial: false });
    }
    Discovery.invalidateSpheres();

    /* Two campaigns built from the cross-posted groups, so the campaign
     * workspace has multi-subreddit data to chart. */
    if (!Campaigns.list().length) {
      try {
        Campaigns.add({
          name: "First Contract Win",
          postIds: Demo.crossPostGroups[0].ids,
          goalScore: 6000,
          goalComments: 700,
        });
        Campaigns.add({
          name: "Single Payer Push",
          postIds: Demo.crossPostGroups[1].ids,
          goalScore: 4000,
          goalComments: 400,
        });
      } catch (err) {
        console.warn("[demo] could not seed campaigns:", err && err.message);
      }
    }

    App.renderChips();
    App.rerenderAll();
    /* Boot already ran a summary pass before these campaigns existed. */
    App.refreshCampaignSummaries().catch(() => {});
    Util.setActionPhase("loaded", `Demo data · ${Util.fmtNum(posts.length)} posts across ${SUBS.length} subreddits · nothing was fetched from Reddit`);
    Util.setStatus(`Demo mode — bundled sample data, no network calls`, "ok");
    showDemoBadge();
    console.log(`[demo] loaded ${posts.length} fixture posts across ${SUBS.length} subs`);
  };

  function describe(sub) {
    const map = {
      labor: "Workplace organizing, union drives, wage theft and the fight for better conditions on the job. Share campaigns, contract wins and organizing questions.",
      healthcare: "Healthcare policy, single payer advocacy, insurance denials and the campaign for universal coverage in the United States.",
      progressive: "Progressive electoral politics, primary challenges, down-ballot organizing and grassroots campaign strategy.",
      climate: "Climate policy, clean energy deployment, utility accountability and local decarbonization campaigns.",
      housing: "Tenant organizing, eviction defense, rent stabilization and the fight for affordable housing.",
      voting: "Voting rights, ballot access, election administration and volunteer poll work.",
    };
    return map[sub.tone] || "";
  }

  /* The way out of demo mode rides along inside the action banner rather
   * than floating over the page — the banner already carries the "this
   * is sample data" message, and a fixed badge covered content on a
   * phone, which is exactly where the viewport is tightest. */
  function showDemoBadge() {
    if (document.getElementById("demo-badge")) return;
    const host = document.querySelector("#action-banner .action-banner-status");
    if (!host) return;
    const badge = document.createElement("a");
    badge.id = "demo-badge";
    badge.className = "demo-badge";
    badge.href = window.location.pathname;
    badge.textContent = "Leave demo mode";
    badge.title = "You are looking at bundled sample data. Click to fetch from Reddit instead.";
    host.appendChild(badge);
  }

  Demo.maybeActivate = function () {
    if (!Demo.isActive()) return false;
    try {
      Demo.activate();
      return true;
    } catch (err) {
      console.warn("[demo] activation failed:", err && err.message);
      return false;
    }
  };

  window.Demo = Demo;
})();
