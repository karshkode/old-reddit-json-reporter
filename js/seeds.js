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
    alabama:        ["Alabama", "Birmingham", "Huntsville", "Alabama_Politics"],
    alaska:         ["alaska", "anchorage"],
    arizona:        ["arizona", "phoenix", "Tucson", "arizonapolitics", "AZPolitics"],
    arkansas:       ["Arkansas", "LittleRock", "ArkansasPolitics"],
    california:     ["California", "BayArea", "LosAngeles", "sandiego", "sacramento", "oakland", "CaliforniaPolitics"],
    colorado:       ["Colorado", "Denver", "ColoradoSprings", "Boulder", "ColoradoPolitics"],
    connecticut:    ["Connecticut", "Hartford", "newhaven", "ConnecticutPolitics"],
    delaware:       ["Delaware", "WilmingtonDE"],
    florida:        ["florida", "Miami", "Orlando", "Tampa", "JacksonvilleFL", "FloridaPolitics"],
    georgia:        ["Georgia", "Atlanta", "Savannah", "GeorgiaPolitics"],
    hawaii:         ["Hawaii", "Honolulu", "HawaiiPolitics"],
    idaho:          ["Idaho", "Boise"],
    illinois:       ["illinois", "chicago", "Springfield", "IllinoisPolitics"],
    indiana:        ["Indiana", "Indianapolis", "fortwayne", "IndianaPolitics"],
    iowa:           ["Iowa", "DesMoines", "iowacity", "IowaPolitics"],
    kansas:         ["kansas", "kansascity"],
    kentucky:       ["Kentucky", "Louisville", "Lexington", "KentuckyPolitics"],
    louisiana:      ["Louisiana", "NewOrleans", "BatonRouge", "LouisianaPolitics"],
    maine:          ["Maine", "Portland_ME"],
    maryland:       ["maryland", "baltimore", "MarylandPolitics"],
    massachusetts:  ["massachusetts", "boston", "Cambridge", "MassachusettsPolitics", "MAPoliticalCorner"],
    michigan:       ["Michigan", "Detroit", "AnnArbor", "GrandRapids", "MichiganPolitics"],
    minnesota:      ["minnesota", "minneapolis", "TwinCities", "MNpolitics", "MinnesotaPolitics"],
    mississippi:    ["mississippi", "Jackson_MS"],
    missouri:       ["missouri", "StLouis", "kansascity", "MissouriPolitics"],
    montana:        ["Montana", "billings"],
    nebraska:       ["Nebraska", "Omaha", "lincoln"],
    nevada:         ["Nevada", "vegas", "Reno"],
    newhampshire:   ["newhampshire", "Manchester_NH", "NHPolitics"],
    newjersey:      ["newjersey", "Newark", "JerseyCity", "NJPolitics", "NewJerseyPolitics"],
    newmexico:      ["NewMexico", "Albuquerque", "SantaFe", "NewMexicoPolitics"],
    newyork:        ["newyork", "nyc", "AskNYC", "Albany", "Buffalo", "rochesterny", "NewYorkPolitics", "NYpolitics"],
    northcarolina:  ["NorthCarolina", "raleigh", "Charlotte", "Asheville", "NorthCarolinaPolitics"],
    northdakota:    ["northdakota", "fargo"],
    ohio:           ["Ohio", "cleveland", "cincinnati", "Columbus", "OhioPolitics"],
    oklahoma:       ["oklahoma", "OklahomaCity", "tulsa", "OklahomaPolitics"],
    oregon:         ["oregon", "Portland", "Eugene", "OregonPolitics"],
    pennsylvania:   ["pennsylvania", "philadelphia", "pittsburgh", "Harrisburg", "PennsylvaniaPolitics"],
    rhodeisland:    ["RhodeIsland", "Providence"],
    southcarolina:  ["southcarolina", "Charleston", "Columbia", "SouthCarolinaPolitics"],
    southdakota:    ["SouthDakota", "siouxfalls"],
    tennessee:      ["Tennessee", "nashville", "memphis", "knoxville", "TennesseePolitics"],
    texas:          ["texas", "Austin", "Houston", "Dallas", "SanAntonio", "fortworth", "TexasPolitics"],
    utah:           ["Utah", "SaltLakeCity", "UtahPolitics"],
    vermont:        ["vermont", "BurlingtonVT"],
    virginia:       ["Virginia", "rva", "nova", "VirginiaPolitics", "VAPolitics"],
    washington:     ["Washington", "Seattle", "Spokane", "Tacoma", "WAPolitics", "WashingtonStatePolitics"],
    westvirginia:   ["WestVirginia", "Charleston_WV"],
    wisconsin:      ["wisconsin", "milwaukee", "Madison", "WisconsinPolitics"],
    wyoming:        ["wyoming", "cheyenne"],
    dc:             ["washingtondc", "WashingtonDC", "dcpolitics"],
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

  /* ---------- Issue lexicons ----------
   *
   * These used to be a trigger table: if a campaign keyword appeared
   * verbatim in a sphere's list, the sphere was "detected", otherwise it
   * was invisible. js/discovery.js now treats them as the seed vocabulary
   * for each sphere's term vector, ranking every sphere by overlap, so
   * the lists want to be *representative of how people write about the
   * issue* rather than a minimal set of unambiguous tokens.
   *
   * That changes the editing rules in two ways. Breadth helps: a term
   * that appears in real post titles earns its place even if it is not
   * definitional. Overlap hurts: "rent" sitting in both labor and
   * housing used to be harmless belt-and-braces, but now it drags a
   * union campaign toward the tenancy sphere. Each term belongs to the
   * one issue it most identifies. */
  Seeds.SPHERE_TRIGGERS = {
    progressive: ["progressive", "socialist", "socialism", "democrat", "democratic", "leftist", "leftwing", "liberal",
      "abolitionist", "antifascist", "primary", "incumbent", "challenger", "caucus", "platform", "grassroots",
      "canvass", "canvassing", "doorknock", "fundraising", "smalldollar", "downballot", "councilmember", "legislature"],
    movement: ["movement", "march", "protest", "rally", "organize", "organizing", "organizer", "strike", "picket",
      "occupy", "boycott", "walkout", "sitin", "directaction", "solidarity", "coalition", "mutualaid", "volunteer",
      "turnout", "demonstration", "civildisobedience"],
    healthcare: ["healthcare", "medicare", "medicaid", "singlepayer", "payer", "universal", "coverage", "insurance",
      "insurer", "hospital", "clinic", "doctor", "nurse", "patient", "prescription", "drug", "pharmacy",
      "pharmaceutical", "premium", "premiums", "deductible", "copay", "claim", "denial", "publicoption", "billing"],
    labor: ["labor", "labour", "union", "unionize", "unionization", "organizing", "worker", "workers", "workplace",
      "wage", "wages", "overtime", "scheduling", "employer", "employee", "boss", "manager", "shift", "warehouse",
      "contract", "bargaining", "grievance", "steward", "strikefund", "unionbusting", "nlrb", "unemployment",
      "wagetheft", "amazon", "starbucks", "layoff", "layoffs"],
    voting: ["vote", "voter", "voters", "voting", "ballot", "ballots", "election", "elections", "registration",
      "polling", "pollworker", "precinct", "gerrymander", "gerrymandering", "suppression", "turnout", "mailin",
      "absentee", "earlyvoting", "signaturematch", "disenfranchise"],
    climate: ["climate", "environment", "environmental", "green", "ecology", "pollution", "carbon", "emissions",
      "fossil", "renewable", "solar", "wind", "grid", "utility", "electrification", "heatpump", "decarbonize",
      "decarbonization", "netmetering", "interconnection", "drilling", "pipeline", "wildfire", "heatwave", "flooding"],
    reproductive: ["abortion", "reproductive", "roe", "wade", "planned", "parenthood", "contraception", "contraceptive",
      "miscarriage", "ivf", "prenatal", "maternal", "clinic", "bodilyautonomy", "trigger", "ban"],
    immigration: ["immigration", "immigrant", "migrant", "asylum", "border", "deportation", "detention", "ice",
      "dreamer", "daca", "refugee", "visa", "citizenship", "naturalization", "sanctuary", "raid"],
    education: ["education", "school", "schools", "student", "students", "loan", "loans", "debt", "forgiveness",
      "teacher", "teachers", "university", "college", "tuition", "curriculum", "schoolboard", "bookban",
      "publicschool", "charter", "pell"],
    housing: ["housing", "homeless", "homelessness", "tenant", "tenants", "rent", "renter", "landlord", "lease",
      "evict", "evicted", "eviction", "mortgage", "rental", "zoning", "affordable", "stabilization", "vacancy",
      "habitability", "repairs", "deposit", "gentrification", "nimby", "upzoning"],
    palestine_gaza: ["palestine", "palestinian", "gaza", "israel", "israeli", "ceasefire", "intifada", "westbank",
      "occupation", "settler", "bds", "divest", "apartheid"],
    racial_justice: ["racial", "racism", "racist", "antiracist", "blacklivesmatter", "george", "floyd", "policing",
      "police", "brutality", "reparations", "redlining", "segregation", "profiling", "civilrights"],
    media_news: ["media", "press", "journalism", "journalist", "newsroom", "propaganda", "disinformation",
      "misinformation", "censor", "censorship", "paywall", "localnews", "factcheck", "bias"],
  };

  Seeds.DEMOGRAPHIC_TRIGGERS = {
    lgbtq: ["lgbt", "lgbtq", "queer", "gay", "lesbian", "trans", "transgender", "bisexual", "nonbinary",
      "pronoun", "genderaffirming", "pride", "drag"],
    women: ["woman", "women", "feminist", "feminism", "girl", "girls", "mother", "mothers", "maternity",
      "childcare", "paygap", "harassment"],
    bipoc: ["black", "blacklives", "asian", "latino", "latina", "latinx", "hispanic", "indigenous", "native",
      "tribal", "immigrantcommunity", "diaspora"],
    veterans: ["veteran", "veterans", "soldier", "military", "va", "servicemember", "deployment", "gibill"],
  };

  /* ---------- Helpers ---------- */

  /* Returns a flat, deduped list of canonical sub names from selected
   * sphere keys. */
  /* Human-readable labels for the picker dropdowns + chips. */
  Seeds.ISSUE_LABELS = {
    progressive:    "Progressive politics",
    movement:       "Activism / movement",
    healthcare:     "Healthcare",
    labor:          "Labor / unions",
    voting:         "Voting & elections",
    climate:        "Climate",
    reproductive:   "Reproductive rights",
    immigration:    "Immigration",
    education:      "Education",
    housing:        "Housing",
    palestine_gaza: "Palestine / Gaza",
    racial_justice: "Racial justice",
    media_news:     "Media & news",
  };

  Seeds.DEMOGRAPHIC_LABELS = {
    lgbtq:        "LGBTQ+",
    women:        "Women",
    young_voters: "Young voters",
    bipoc:        "BIPOC",
    veterans:     "Veterans",
    seniors:      "Seniors",
  };

  /* Pretty state names for the dropdown. Matches keys in STATE_SPHERES. */
  Seeds.STATE_LABELS = {
    alabama: "Alabama", alaska: "Alaska", arizona: "Arizona", arkansas: "Arkansas",
    california: "California", colorado: "Colorado", connecticut: "Connecticut",
    delaware: "Delaware", florida: "Florida", georgia: "Georgia", hawaii: "Hawaii",
    idaho: "Idaho", illinois: "Illinois", indiana: "Indiana", iowa: "Iowa",
    kansas: "Kansas", kentucky: "Kentucky", louisiana: "Louisiana", maine: "Maine",
    maryland: "Maryland", massachusetts: "Massachusetts", michigan: "Michigan",
    minnesota: "Minnesota", mississippi: "Mississippi", missouri: "Missouri",
    montana: "Montana", nebraska: "Nebraska", nevada: "Nevada",
    newhampshire: "New Hampshire", newjersey: "New Jersey", newmexico: "New Mexico",
    newyork: "New York", northcarolina: "North Carolina", northdakota: "North Dakota",
    ohio: "Ohio", oklahoma: "Oklahoma", oregon: "Oregon", pennsylvania: "Pennsylvania",
    rhodeisland: "Rhode Island", southcarolina: "South Carolina", southdakota: "South Dakota",
    tennessee: "Tennessee", texas: "Texas", utah: "Utah", vermont: "Vermont",
    virginia: "Virginia", washington: "Washington", westvirginia: "West Virginia",
    wisconsin: "Wisconsin", wyoming: "Wyoming", dc: "Washington DC",
  };

  /* One label-of helper for any sphere key (issue / state / demo).
   * Returns a friendly name for use in chips and dropdowns. */
  Seeds.labelOf = function (key) {
    if (!key) return "";
    if (Seeds.ISSUE_LABELS[key]) return Seeds.ISSUE_LABELS[key];
    if (Seeds.DEMOGRAPHIC_LABELS[key]) return Seeds.DEMOGRAPHIC_LABELS[key];
    if (Seeds.STATE_LABELS[key]) return Seeds.STATE_LABELS[key];
    return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  };

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

  /* ---------- Starter bundles ----------
   * Cross-sphere combinations that make a sensible first load. The old
   * build only offered these once, on the very first run, through a
   * drawer that disappeared as soon as a single sub existed. They are
   * now permanent fixtures of the Communities view, because "load me a
   * sensible set of progressive subs" is a recurring need, not a
   * one-time onboarding step. */
  Seeds.BUNDLES = [
    {
      key: "progressive-core",
      label: "Progressive core",
      description: "The backbone of the progressive sphere on Reddit — party-adjacent politics, democratic socialism and left commentary.",
      spheres: ["progressive", "voting"],
    },
    {
      key: "movement",
      label: "Movement & direct action",
      description: "Protest organising, general-strike planning and the anti-authoritarian networks that coordinate turnout.",
      spheres: ["movement", "labor"],
    },
    {
      key: "economic-justice",
      label: "Economic justice",
      description: "Work, wages, housing and healthcare — where material-conditions organising happens.",
      spheres: ["labor", "housing", "healthcare"],
    },
    {
      key: "civil-rights",
      label: "Civil rights",
      description: "Racial justice, reproductive rights, immigration and LGBTQ organising.",
      spheres: ["racial_justice", "reproductive", "immigration", "lgbtq"],
    },
    {
      key: "climate",
      label: "Climate",
      description: "Climate policy, Green New Deal advocacy and the sustainability communities around them.",
      spheres: ["climate"],
    },
    {
      key: "everything",
      label: "Everything (issues)",
      description: "Every issue sphere in the catalog. A wide net — expect to trim it afterwards.",
      spheres: null, /* resolved to all issue keys at call time */
    },
  ];

  Seeds.bundleSubs = function (bundleKey) {
    const bundle = Seeds.BUNDLES.find((b) => b.key === bundleKey);
    if (!bundle) return [];
    const spheres = bundle.spheres || Object.keys(Seeds.ISSUE_SPHERES);
    return Seeds.expand(spheres.filter((k) => Seeds.ISSUE_SPHERES[k] || Seeds.DEMOGRAPHIC_SPHERES[k]));
  };

  /* Every sub in the catalog, deduped. Used to warm the local index so
   * similarity search has something to work with offline. */
  Seeds.allSubs = function () {
    const out = new Set();
    for (const map of [Seeds.ISSUE_SPHERES, Seeds.DEMOGRAPHIC_SPHERES, Seeds.STATE_SPHERES]) {
      for (const list of Object.values(map)) for (const s of list) out.add(s);
    }
    return Array.from(out);
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
