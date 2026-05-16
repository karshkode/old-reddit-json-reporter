/* Curated subreddit catalog organised by political/civic sphere.
 *
 * Used by the discovery engine as seed-list of *known-good* candidates so
 * a campaign about healthcare, voting, climate, etc. always has the
 * relevant progressive-sphere subs in its candidate pool — even when
 * Reddit's /subreddits/search query doesn't surface them naturally.
 *
 * Each sphere maps to an array of canonical subreddit display names.
 * Names are lowercased internally for matching but stored title-case
 * here so they render nicely if the candidate isn't reachable.
 *
 * Two types of catalog:
 *   ISSUE_SPHERES      — auto-detected from a campaign's top keywords
 *   STATE_SPHERES      — used for geo-targeted campaigns (candidate AMAs,
 *                        state-level rallies, etc.). Not auto-detected
 *                        from keywords; surfaced for manual selection
 *                        in a future PR.
 *   DEMOGRAPHIC_SPHERES — identity-aligned audiences.
 *
 * The catalog is intentionally curated and bounded — the goal is the
 * "60% case" of progressive-political campaign audiences, not an
 * exhaustive directory.
 */
(function () {
  const Seeds = {};

  /* ---------- Issue spheres ---------- */
  Seeds.ISSUE_SPHERES = {
    progressive: [
      "Political_Revolution", "DemocraticSocialism", "OurPresident",
      "WayOfTheBern", "SandersForPresident", "BlueMidterm2018",
      "ProgressivePolitics", "progun", "LeftWithoutEdge",
      "ABoringDystopia", "LateStageCapitalism", "Anarchism",
    ],
    movement: [
      "50501", "50501movement", "50501ContentCorner", "NoKingsMovement",
      "MayDayStrike", "GeneralStrike", "GeneralStrikeUSA", "WorldStrike",
      "antifascistsofreddit", "AntiFascistsOfReddit", "AntiTrump",
      "WhitePeopleTwitter", "ThePeoplesPress", "TheDefianceDispatch",
      "ProgressiveHQ",
    ],
    healthcare: [
      "MedicareForAll", "healthcare", "publichealth", "medicine",
      "AskDocs", "nursing", "HealthcareReform", "SinglePayer",
    ],
    labor: [
      "WorkReform", "antiwork", "union", "Unions", "labor",
      "WorkersRights", "EndForcedArbitration", "AmazonWorkers",
      "starbucks_baristas", "AmazonFC",
    ],
    voting: [
      "VoterSuppression", "StopVoterSuppression", "ProgressiveVoters",
      "SaneVoting", "VotingRights", "fairelections", "GerryMandering",
      "EndCitizensUnited",
    ],
    climate: [
      "climate", "ClimateActionPlan", "ClimateChange",
      "ClimateOffensive", "GreenNewDeal", "Sustainability",
      "FossilFuelPhaseOut", "RenewableEnergy",
    ],
    reproductive: [
      "TwoXChromosomes", "Feminism", "ReproductiveRights",
      "auntienetwork", "abortion", "PlannedParenthood", "RoeVWade",
    ],
    immigration: [
      "immigration", "AsylumSeekers", "DACA", "Dreamers",
      "ImmigrantsRights", "AbolishICE",
    ],
    education: [
      "EducationPolicy", "studentloans", "publiceducation",
      "FreeCollege", "TeachersUnion",
    ],
    housing: [
      "Housing", "homeowners", "Tenants", "TenantUnion",
      "AffordableHousing", "Homelessness", "Anti_Eviction",
    ],
    palestine_gaza: [
      "Palestine", "FreePalestine", "GazaWar",
      "ProPalestine", "AntiZionism",
    ],
    racial_justice: [
      "BlackLivesMatter", "BlackPeopleTwitter",
      "RacialJustice", "AfroAmerican",
    ],
    media_news: [
      "AntiMedia", "MediaCriticism", "TrueAnon",
    ],
  };

  /* ---------- State spheres (US) ---------- */
  /* For each state, the main state-wide sub plus 1-3 major-city subs.
   * Used for candidate AMAs, state legislative campaigns, district-level
   * organising. Manual selection only — not auto-detected. */
  Seeds.STATE_SPHERES = {
    alabama:        ["Alabama", "Birmingham", "Huntsville"],
    alaska:         ["alaska", "anchorage"],
    arizona:        ["arizona", "phoenix", "Tucson"],
    arkansas:       ["Arkansas", "LittleRock"],
    california:     ["California", "BayArea", "LosAngeles", "sandiego", "sacramento", "oakland"],
    colorado:       ["Colorado", "Denver", "ColoradoSprings", "Boulder"],
    connecticut:    ["Connecticut", "Hartford", "newhaven"],
    delaware:       ["Delaware", "WilmingtonDE"],
    florida:        ["florida", "Miami", "Orlando", "Tampa", "JacksonvilleFL"],
    georgia:        ["Georgia", "Atlanta", "Savannah"],
    hawaii:         ["Hawaii", "Honolulu"],
    idaho:          ["Idaho", "Boise"],
    illinois:       ["illinois", "chicago", "Springfield"],
    indiana:        ["Indiana", "Indianapolis", "fortwayne"],
    iowa:           ["Iowa", "DesMoines", "iowacity"],
    kansas:         ["kansas", "kansascity"],
    kentucky:       ["Kentucky", "Louisville", "Lexington"],
    louisiana:      ["Louisiana", "NewOrleans", "BatonRouge"],
    maine:          ["Maine", "Portland_ME"],
    maryland:       ["maryland", "baltimore"],
    massachusetts:  ["massachusetts", "boston", "Cambridge"],
    michigan:       ["Michigan", "Detroit", "AnnArbor", "GrandRapids"],
    minnesota:      ["minnesota", "minneapolis", "TwinCities"],
    mississippi:    ["mississippi", "Jackson_MS"],
    missouri:       ["missouri", "StLouis", "kansascity"],
    montana:        ["Montana", "billings"],
    nebraska:       ["Nebraska", "Omaha", "lincoln"],
    nevada:         ["Nevada", "vegas", "Reno"],
    newhampshire:   ["newhampshire", "Manchester_NH"],
    newjersey:      ["newjersey", "Newark", "JerseyCity"],
    newmexico:      ["NewMexico", "Albuquerque", "SantaFe"],
    newyork:        ["newyork", "nyc", "AskNYC", "Albany", "Buffalo", "rochesterny"],
    northcarolina:  ["NorthCarolina", "raleigh", "Charlotte", "Asheville"],
    northdakota:    ["northdakota", "fargo"],
    ohio:           ["Ohio", "cleveland", "cincinnati", "Columbus"],
    oklahoma:       ["oklahoma", "OklahomaCity", "tulsa"],
    oregon:         ["oregon", "Portland", "Eugene"],
    pennsylvania:   ["pennsylvania", "philadelphia", "pittsburgh", "Harrisburg"],
    rhodeisland:    ["RhodeIsland", "Providence"],
    southcarolina:  ["southcarolina", "Charleston", "Columbia"],
    southdakota:    ["SouthDakota", "siouxfalls"],
    tennessee:      ["Tennessee", "nashville", "memphis", "knoxville"],
    texas:          ["texas", "Austin", "Houston", "Dallas", "SanAntonio", "fortworth"],
    utah:           ["Utah", "SaltLakeCity"],
    vermont:        ["vermont", "BurlingtonVT"],
    virginia:       ["Virginia", "rva", "nova"],
    washington:     ["Washington", "Seattle", "Spokane", "Tacoma"],
    westvirginia:   ["WestVirginia", "Charleston_WV"],
    wisconsin:      ["wisconsin", "milwaukee", "Madison"],
    wyoming:        ["wyoming", "cheyenne"],
    dc:             ["washingtondc", "WashingtonDC"],
  };

  /* ---------- Demographic spheres ---------- */
  Seeds.DEMOGRAPHIC_SPHERES = {
    lgbtq:        ["lgbt", "gay", "transgender", "bisexual", "lesbian", "ainbow", "actuallesbians", "AskLGBT"],
    women:        ["TwoXChromosomes", "askwomen", "Feminism", "WomenInNews", "AskFeminists"],
    young_voters: ["GenZ", "teenagers", "AskMen", "college", "GradSchool"],
    bipoc:        ["BlackPeopleTwitter", "BlackLivesMatter", "AsianAmerican", "Latino", "indigenous"],
    veterans:     ["Veterans", "Military", "USMC", "army"],
    seniors:      ["AARP", "olderthan30", "Eldergoth"],
  };

  /* ---------- Auto-detection triggers ---------- */
  /* Map each issue sphere to a small set of trigger keywords. If the
   * campaign profile's keywords include any trigger, the sphere is
   * "detected" for that campaign. Conservative — better to under-detect
   * than over-detect. */
  Seeds.SPHERE_TRIGGERS = {
    progressive:    ["progressive", "socialist", "democrat", "leftist", "leftwing", "liberal", "abolitionist", "antifascist"],
    movement:       ["movement", "march", "protest", "rally", "organize", "organizing", "strike", "occupy", "boycott"],
    healthcare:     ["healthcare", "medicare", "medicaid", "insurance", "hospital", "doctor", "patient", "drug", "pharmaceutical", "premiums", "deductible"],
    labor:          ["labor", "labour", "union", "worker", "workers", "wage", "wages", "minimum", "tenant", "rent", "employed", "unemployment", "amazon", "starbucks"],
    voting:         ["vote", "voter", "voters", "voting", "ballot", "ballots", "election", "registration", "polling", "gerrymander", "suppression"],
    climate:        ["climate", "environment", "environmental", "green", "ecology", "pollution", "carbon", "emissions", "fossil", "renewable"],
    reproductive:   ["abortion", "reproductive", "roe", "wade", "planned", "parenthood", "contraception", "miscarriage", "ivf"],
    immigration:    ["immigration", "immigrant", "asylum", "border", "deportation", "ice", "dreamer", "daca", "refugee"],
    education:      ["education", "school", "schools", "student", "students", "loan", "loans", "teacher", "teachers", "university", "college", "tuition"],
    housing:        ["housing", "homeless", "homelessness", "tenant", "tenants", "rent", "landlord", "evict", "evicted", "eviction", "mortgage", "rental"],
    palestine_gaza: ["palestine", "palestinian", "gaza", "israeli", "ceasefire", "intifada", "westbank"],
    racial_justice: ["racial", "racism", "antiracist", "blacklivesmatter", "george", "floyd", "policing", "brutality"],
    media_news:     ["media", "press", "journalism", "propaganda", "disinformation", "censor", "censorship"],
  };

  Seeds.DEMOGRAPHIC_TRIGGERS = {
    lgbtq:        ["lgbt", "lgbtq", "queer", "gay", "lesbian", "trans", "transgender", "bisexual", "nonbinary"],
    women:        ["woman", "women", "feminist", "feminism", "girl", "girls", "mother", "mothers"],
    bipoc:        ["black", "blacklives", "asian", "latino", "latina", "hispanic", "indigenous", "native"],
    veterans:     ["veteran", "veterans", "soldier", "military"],
  };

  /* ---------- Helpers ---------- */

  /* Returns a flat, deduped list of canonical sub names from selected
   * sphere keys. */
  Seeds.expand = function (sphereKeys) {
    const out = new Set();
    for (const key of (sphereKeys || [])) {
      const issue = Seeds.ISSUE_SPHERES[key] || [];
      const state = Seeds.STATE_SPHERES[key] || [];
      const demo  = Seeds.DEMOGRAPHIC_SPHERES[key] || [];
      for (const s of issue) out.add(s);
      for (const s of state) out.add(s);
      for (const s of demo) out.add(s);
    }
    return Array.from(out);
  };

  /* Reverse map: given a sub name (any case), return the sphere keys
   * it belongs to. Cached on first access. */
  let _subToSpheres = null;
  function buildIndex() {
    const idx = new Map();
    function add(map, prefix) {
      for (const [k, list] of Object.entries(map)) {
        for (const sub of list) {
          const lk = sub.toLowerCase();
          if (!idx.has(lk)) idx.set(lk, []);
          idx.get(lk).push((prefix || "") + k);
        }
      }
    }
    add(Seeds.ISSUE_SPHERES);
    add(Seeds.STATE_SPHERES, "state:");
    add(Seeds.DEMOGRAPHIC_SPHERES, "demo:");
    _subToSpheres = idx;
  }
  Seeds.spheresOf = function (subName) {
    if (!_subToSpheres) buildIndex();
    return _subToSpheres.get(String(subName || "").toLowerCase()) || [];
  };
  Seeds.isCatalogMember = function (subName) {
    return Seeds.spheresOf(subName).length > 0;
  };

  /* Detect issue + demographic spheres from a campaign profile.
   * Triggers are matched against the campaign's top keywords + bigrams
   * (case-insensitive substring). Returns ordered array of detected
   * sphere keys, most-confident first. */
  Seeds.detectSpheres = function (campaignProfile) {
    if (!campaignProfile) return [];
    const text = (
      (campaignProfile.keywords || []).map((k) => k.word).join(" ") + " " +
      (campaignProfile.bigrams || []).map((b) => b.phrase).join(" ")
    ).toLowerCase();
    if (!text.trim()) return [];

    const score = {};
    function tally(triggerMap) {
      for (const [sphere, triggers] of Object.entries(triggerMap)) {
        for (const t of triggers) {
          if (text.indexOf(t) >= 0) score[sphere] = (score[sphere] || 0) + 1;
        }
      }
    }
    tally(Seeds.SPHERE_TRIGGERS);
    tally(Seeds.DEMOGRAPHIC_TRIGGERS);

    return Object.entries(score)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
  };

  /* All available sphere keys (for UI selection). */
  Seeds.allSphereKeys = function () {
    return [
      ...Object.keys(Seeds.ISSUE_SPHERES),
      ...Object.keys(Seeds.DEMOGRAPHIC_SPHERES),
    ];
  };
  Seeds.allStateKeys = function () {
    return Object.keys(Seeds.STATE_SPHERES);
  };

  window.Seeds = Seeds;
})();
