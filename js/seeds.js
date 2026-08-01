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
 *
 * MEMBERSHIP RULES
 *
 * Every issue and demographic entry below was checked against the
 * Arctic Shift archive rather than recalled, because an unchecked
 * catalog rots quietly and in ways that are invisible from the UI. The
 * first audit found that a third of it was unusable: nineteen names had
 * no subreddit behind them at all, eighteen more were private or
 * restricted so nobody could post there anyway, and r/Dreamers — filed
 * under immigration — is a subreddit for an alt-rock band from Los
 * Angeles. r/Tenants had 204 subscribers while r/Tenant, which nobody
 * had added, had sixty-three thousand.
 *
 * A name earns its place by clearing four bars:
 *
 *   exists      the archive has metadata or posts for it
 *   public      not private, restricted or banned — a suggestion you
 *               cannot act on is worse than no suggestion
 *   alive       somebody posted within the last 30 days
 *   reachable   at least 1,000 subscribers, which is roughly where a
 *               sub has enough traffic for the timing model to find
 *               anything in it
 *
 * Two judgement calls sit on top of those. Communities organised
 * *against* a sphere's aims are left out even when they are the biggest
 * result for its vocabulary — r/Firearms is where gun policy is argued,
 * not an audience for gun-violence-prevention organising. And
 * professional-practice subs that ban advocacy are left out even when
 * the topic matches, because a recommendation to post a campaign in
 * r/pharmacy is a recommendation to get removed.
 */
(function () {
  const Seeds = {};

  /* ---------- Issue spheres ---------- */
  Seeds.ISSUE_SPHERES = {
    progressive: [
      "Political_Revolution", "DemocraticSocialism", "SandersForPresident",
      "OurPresident", "WayOfTheBern", "socialism", "Socialism_101",
      "SocialDemocracy", "dsa", "democrats", "Liberal", "AskALiberal",
      "leftist", "LeftWithoutEdge", "GreenParty", "Anarchism", "Anarchy101",
      "LateStageCapitalism", "ABoringDystopia", "politics",
      "PoliticalDiscussion", "Ask_Politics",
    ],
    movement: [
      "50501", "50501ContentCorner", "MayDayStrike", "protest",
      "AntifascistsofReddit", "MarchAgainstNazis", "antitrump", "esist",
      "EnoughTrumpSpam", "Defeat_Project_2025", "WhitePeopleTwitter",
      "ThePeoplesPress", "TheDefianceDispatch", "MutualAid", "IWW",
      "WorkersStrikeBack", "BoycottUnitedStates",
    ],
    healthcare: [
      "MedicareForAll", "healthcare", "HealthInsurance", "medicare",
      "Medicaid", "MedicalBill", "publichealth", "medicine", "AskDocs",
      "nursing",
    ],
    labor: [
      "WorkReform", "antiwork", "union", "Unions", "unionsolidarity",
      "labor", "workingclass", "WorkersRights", "WorkersStrikeBack",
      "Workers_Revolt", "IWW", "EmploymentLaw", "LaborLaw", "WorkersComp",
      "AmazonFC", "starbucksbaristas",
    ],
    voting: [
      "VoteDEM", "VoteBlue", "Keep_Track", "EndFPTP", "democracy",
      "electionreform", "RankedChoiceVoting", "YAPms", "fivethirtyeight",
    ],
    climate: [
      "climate", "climatechange", "ClimateActionPlan", "ClimateOffensive",
      "ClimateMemes", "GreenNewDeal", "environment", "environmental_science",
      "sustainability", "ZeroWaste", "Anticonsumption", "RenewableEnergy",
      "solarpunk", "energy", "Green",
    ],
    reproductive: [
      "TwoXChromosomes", "Feminism", "prochoice", "abortion", "auntienetwork",
      "PlannedParenthood", "StrikeForRoe", "birthcontrol", "WomensHealth",
    ],
    immigration: [
      "immigration", "USCIS", "DACA",
    ],
    education: [
      "StudentLoans", "Teachers", "TeachersInTransition", "education",
      "Professors", "academia", "AskAcademia", "CollegeRant",
    ],
    housing: [
      "Renters", "Tenant", "TenantHelp", "LandlordLove", "homeless", "yimby",
    ],
    palestine_gaza: [
      "Palestine", "palestinenews", "Gaza", "IsraelPalestine", "jewishleft",
    ],
    racial_justice: [
      "BlackLivesMatter", "BlackPeopleTwitter", "blackladies", "racism",
      "policebrutality", "Bad_Cop_No_Donut", "CivilRights",
    ],
    media_news: [
      "Journalism", "media_criticism", "MediaCriticism", "FreePress",
      "qualitynews", "neutralnews", "TrueReddit", "inthenews",
      "indepthstories", "Foodforthought",
    ],
    /* Courts, oversight and the machinery of self-government. Split out
       from voting because "how a ballot is counted" and "whether a
       ruling is obeyed" draw different crowds and different arguments. */
    democracy: [
      "Keep_Track", "Defeat_Project_2025", "law", "scotus", "supremecourt",
      "Ask_Lawyers", "NeutralPolitics", "democracy", "Constitution",
    ],
    criminal_justice: [
      "Bad_Cop_No_Donut", "policebrutality", "ACAB", "Prison", "prisonreform",
      "publicdefenders",
    ],
    /* r/Firearms and r/gunpolitics are bigger and match the vocabulary
       better than anything here. They are also where this campaign
       would be argued with rather than heard, so the sphere is limited
       to prevention communities and to the two explicitly left-leaning
       gun-owner subs, which are a real constituency for safe-storage
       and red-flag arguments. */
    gun_violence: [
      "guncontrol", "GunsAreCool", "liberalgunowners", "2ALiberals",
    ],
    disability: [
      "disability", "disabled", "SSDI", "ChronicIllness", "AutisticAdults",
      "Blind", "deaf",
    ],
    safety_net: [
      "SocialSecurity", "foodstamps", "Food_Pantry", "BasicIncome",
      "poverty", "povertyfinance", "Assistance",
    ],
    tech_privacy: [
      "privacy", "technology", "netneutrality", "degoogle",
      "StallmanWasRight", "BigTech",
    ],
    urbanism: [
      "urbanplanning", "urbanism", "transit", "fuckcars", "StrongTowns",
      "yimby",
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
    dc:             ["washingtondc", "dcpolitics"],
  };

  /* ---------- Demographic spheres ---------- */
  /* The seniors row used to be r/AARP (8 subscribers, restricted),
     r/olderthan30 (does not exist) and r/Eldergoth, which is about goth
     subculture rather than about being old. All three are replaced with
     communities that actually contain the constituency. */
  Seeds.DEMOGRAPHIC_SPHERES = {
    lgbtq:        ["lgbt", "ainbow", "gay", "lesbian", "actuallesbians", "bisexual", "transgender", "trans", "asktransgender", "NonBinary", "LGBTnews", "AskLGBT"],
    women:        ["TwoXChromosomes", "AskWomen", "women", "Feminism", "AskFeminists", "WomenInNews"],
    young_voters: ["GenZ", "Millennials", "college", "GradSchool", "youngadults", "teenagers"],
    bipoc:        ["BlackPeopleTwitter", "blackladies", "asianamerican", "Indigenous", "IndianCountry", "NativeAmerican", "latinoamerica"],
    veterans:     ["Veterans", "VeteransBenefits", "Military", "army", "AirForce", "USMC", "MilitaryFinance"],
    seniors:      ["retirement", "AskOldPeople", "SocialSecurity", "eldercare", "caregivers"],
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
      "abolitionist", "antifascist", "primary election", "incumbent", "caucus", "party platform", "grassroots",
      "canvass", "canvassing", "doorknock", "door knock", "fundraising", "smalldollar", "small dollar",
      "downballot", "down ballot", "councilmember", "council member", "legislature",
      "oligarchy", "billionaire", "billionaires", "wealth tax", "tax the rich", "corporate greed", "class war",
      "redistribution", "populist", "establishment", "primary challenge", "town hall", "constituent",
      "representative", "senator", "congressman", "statehouse", "state house", "endorsement", "platform plank"],
    movement: ["movement", "march", "protest", "protester", "rally", "organize", "organizing", "organizer",
      "occupy", "boycott", "sitin", "sit in", "directaction", "direct action", "solidarity", "coalition",
      "mutualaid", "mutual aid", "volunteer", "demonstration", "civildisobedience", "civil disobedience",
      "generalstrike", "general strike", "nokings", "no kings", "phonebank", "phone bank", "textbank", "text bank",
      "petition", "local chapter", "affinity group", "jail support", "know your rights", "deescalation",
      "flyer", "leaflet", "banner drop", "day of action", "sickout", "die in"],
    healthcare: ["healthcare", "medicare", "medicaid", "singlepayer", "single payer", "payer", "universal",
      "coverage", "insurance", "insurer", "hospital", "clinic", "doctor", "nurse", "patient", "prescription",
      "drug prices", "pharmacy", "pharmaceutical", "premium", "premiums", "deductible", "copay", "claim denial",
      "publicoption", "public option", "billing",
      "coinsurance", "out of pocket", "prior authorization", "formulary", "aca", "obamacare", "marketplace",
      "uninsured", "underinsured", "surprise billing", "medical debt", "mental health", "opioid", "overdose",
      "vaccine", "vaccination", "cdc", "nih", "fda", "hospital closure", "rural hospital", "nursing shortage",
      "ambulance", "telehealth"],
    labor: ["labor", "labour", "union", "unionize", "unionization", "worker", "workers", "workplace",
      "wage", "wages", "overtime", "scheduling", "employer", "employee", "boss", "shift work", "warehouse",
      "union contract", "bargaining", "grievance", "steward", "strikefund", "strike fund", "unionbusting", "union busting",
      "nlrb", "unemployment", "wagetheft", "wage theft", "amazon", "starbucks", "layoff", "layoffs",
      "strike", "picket", "picket line", "walkout", "collective bargaining", "card check", "decertification",
      "scab", "seniority", "sick time", "paid leave", "family leave", "minimum wage", "living wage", "tipped",
      "misclassification", "gig work", "independent contractor", "osha", "workplace injury", "severance",
      "return to office", "outsourcing", "teamsters", "uaw", "seiu", "iww", "shop floor"],
    voting: ["vote", "voter", "voters", "voting", "ballot", "ballots", "election", "elections", "registration",
      "polling", "pollworker", "poll worker", "precinct", "gerrymander", "gerrymandering", "suppression", "turnout",
      "mailin", "mail in", "absentee", "earlyvoting", "early voting", "signaturematch", "signature match",
      "disenfranchise",
      "electorate", "candidate", "ranked choice", "rcv", "approval voting", "electoral college", "redistricting",
      "census", "voter id", "voter roll", "voter purge", "provisional ballot", "drop box", "recount", "gotv",
      "get out the vote", "polling place", "midterm", "midterms", "runoff", "referendum", "ballot initiative",
      "proposition", "recall"],
    climate: ["climate", "environment", "environmental", "green", "ecology", "pollution", "carbon", "emissions",
      "fossil", "renewable", "solar", "wind power", "grid", "utility", "electrification", "heatpump", "heat pump",
      "decarbonize", "decarbonization", "netmetering", "net metering", "interconnection", "drilling", "pipeline",
      "wildfire", "heatwave", "heat wave", "flooding",
      "ratepayer", "power plant", "transmission line", "substation", "aquifer", "groundwater", "methane", "lng",
      "fracking", "coal", "refinery", "petrochemical", "epa", "clean air", "clean water", "superfund", "pfas",
      "biodiversity", "deforestation", "drought", "hurricane", "sea level", "just transition", "conservation",
      "public lands", "electric vehicle", "battery", "geothermal", "offshore wind", "consumption"],
    /* "ban" and "trigger" used to sit here as bare words. Both are
       ordinary English — every sphere in the catalog has bans — so they
       are spelled out as the phrases that actually mean this issue. */
    reproductive: ["abortion", "reproductive", "roe", "roe v wade", "planned parenthood", "contraception", "contraceptive",
      "miscarriage", "ivf", "prenatal", "maternal", "bodilyautonomy", "bodily autonomy", "trigger law", "abortion ban",
      "prochoice", "pro choice", "dobbs", "hyde amendment", "mifepristone", "misoprostol", "medication abortion",
      "gestational", "fetal personhood", "sterilization", "doula", "midwife", "maternal mortality", "obgyn",
      "abortion clinic",
      "birth control", "emergency contraception", "shield law", "waiting period", "parental consent",
      "crisis pregnancy"],
    immigration: ["immigration", "immigrant", "migrant", "asylum", "border", "deportation", "detention",
      "ice raid", "ice detention", "immigration enforcement",
      "dreamer", "daca", "refugee", "visa", "citizenship", "naturalization", "sanctuary",
      "uscis", "green card", "work permit", "tps", "humanitarian parole", "removal proceedings", "deport",
      "detainee", "cbp", "border patrol", "immigration court", "immigration bond", "credible fear",
      "public charge", "e verify", "family separation", "undocumented", "mixed status", "sanctuary city"],
    education: ["education", "school", "schools", "student", "students", "loan", "loans", "debt", "forgiveness",
      "teacher", "teachers", "university", "college", "tuition", "curriculum", "schoolboard", "school board",
      "bookban", "book ban", "publicschool", "public school", "pell grant",
      "fafsa", "borrower", "income driven", "pslf", "accreditation", "adjunct", "tenure", "faculty", "class size",
      "paraprofessional", "special education", "iep", "title i", "voucher", "vouchers", "charter school",
      "homeschool", "pre k", "head start", "school lunch", "campus", "undergraduate", "school funding"],
    housing: ["housing", "homeless", "homelessness", "tenant", "tenants", "rent", "renter", "renters", "landlord",
      "lease", "evict", "evicted", "eviction", "mortgage", "rental", "zoning", "affordable", "stabilization",
      "vacancy", "habitability", "repairs", "deposit", "gentrification", "nimby", "upzoning",
      "rent control", "rent stabilization", "rent burden", "security deposit", "foreclosure", "shelter",
      "encampment", "public housing", "section 8", "housing voucher", "hud", "slumlord", "code violation",
      "mold", "lead paint", "displacement", "rent gouging", "corporate landlord", "realpage", "habitable"],
    palestine_gaza: ["palestine", "palestinian", "gaza", "israel", "israeli", "ceasefire", "intifada", "westbank",
      "occupation", "settler", "bds", "divest", "apartheid",
      "zionism", "zionist", "antizionism", "nakba", "unrwa", "hamas", "idf", "genocide", "ethnic cleansing",
      "blockade", "hostage", "two state solution", "annexation", "rafah", "jerusalem", "jenin", "arms embargo", "aipac"],
    /* Policing vocabulary used to live here, and it is why a post about
       an arrest at a county board meeting arrived tagged as racial
       justice. "police" identifies a subject, not a sphere; the words
       that identify *this* sphere are the ones about race. Policing
       practice now sits in criminal justice, where a reader looking for
       it would go. */
    racial_justice: ["racial", "racism", "racist", "antiracist", "blacklivesmatter", "black lives matter",
      "george floyd", "reparations", "redlining", "segregation", "racial profiling",
      "civilrights", "civil rights",
      "racial disparity", "affirmative action", "hate crime", "lynching", "juneteenth", "hbcu",
      "environmental justice", "wealth gap", "discrimination", "racial bias", "supremacy", "supremacist",
      "jim crow", "desegregation", "colorblind", "microaggression", "racial equity"],
    media_news: ["media", "press", "journalism", "journalist", "newsroom", "propaganda", "disinformation",
      "misinformation", "censor", "censorship", "paywall", "localnews", "local news", "factcheck", "fact check",
      "bias",
      "editorial", "byline", "outlet", "broadcaster", "pundit", "op ed", "letter to the editor", "press freedom",
      "gag order", "foia", "public records", "news desert", "nonprofit news", "substack", "clickbait",
      "astroturf", "sourcing", "anonymous source", "retraction", "investigative", "leaked documents", "reporter"],
    democracy: ["democracy", "authoritarian", "authoritarianism", "autocracy", "autocrat", "fascism", "fascist",
      "dictatorship", "strongman", "rule of law", "constitution", "constitutional", "amendment", "supreme court",
      "scotus", "judge", "judicial", "judiciary", "court", "ruling", "injunction", "precedent", "impeach",
      "impeachment", "corruption", "oversight", "subpoena", "contempt", "checks and balances",
      "separation of powers", "executive order", "federalism", "project 2025", "civil service", "whistleblower",
      "inspector general", "doj", "fbi", "martial law", "insurrection", "coup", "legitimacy", "norms"],
    criminal_justice: ["prison", "prisoner", "incarceration", "incarcerated", "mass incarceration", "jail",
      "cash bail", "sentencing", "mandatory minimum", "parole", "probation", "recidivism", "reentry",
      "expungement", "clemency", "pardon", "commutation", "solitary", "prosecutor", "district attorney",
      "public defender", "plea bargain", "wrongful conviction", "exoneration", "death row", "death penalty",
      "juvenile justice", "private prison", "abolition", "defund", "police union", "no knock", "warrant",
      "correctional", "police", "policing", "officer", "arrest", "arrested", "brutality", "chokehold",
      "qualified immunity", "consent decree", "bodycam", "body camera", "traffic stop", "stop and frisk",
      "excessive force", "misconduct", "sheriff", "deputy", "custody"],
    gun_violence: ["gun", "guns", "firearm", "firearms", "shooting", "shootings", "mass shooting",
      "school shooting", "gun violence", "gun control", "gun safety", "background check", "red flag", "erpo",
      "assault weapon", "high capacity", "ghost gun", "concealed carry", "permitless", "atf", "nra",
      "second amendment", "buyback", "safe storage", "active shooter", "gun show", "straw purchase",
      "lockdown drill", "gun lobby"],
    disability: ["disability", "disabled", "accessibility", "accessible", "accommodation", "americans with disabilities",
      "wheelchair", "mobility aid", "curb cut", "blind", "deaf", "hard of hearing", "asl", "captioning",
      "screen reader", "autistic", "autism", "neurodivergent", "chronic illness", "long covid", "ssdi", "ssi",
      "disability benefits", "home care", "institutionalization", "guardianship", "subminimum wage",
      "paratransit", "service dog", "ableism", "ableist", "spoons"],
    safety_net: ["snap", "ebt", "food stamp", "food stamps", "wic", "tanf", "welfare", "safety net", "public benefits",
      "eligibility", "recertification", "work requirement", "benefits cliff", "poverty", "poverty line",
      "low income", "food insecurity", "food bank", "food pantry", "liheap", "child tax credit", "eitc",
      "basic income", "ubi", "guaranteed income", "cash assistance", "social security", "retirement", "pension",
      "cost of living", "means testing", "hunger", "paycheck to paycheck"],
    tech_privacy: ["privacy", "surveillance", "data center", "datacenter", "server farm", "artificial intelligence",
      "algorithm", "algorithmic", "automation", "chatbot", "llm", "training data", "scraping",
      "facial recognition", "biometric", "tracking", "tracker", "gdpr", "data broker", "encryption", "backdoor",
      "spyware", "license plate reader", "net neutrality", "broadband", "digital divide", "monopoly", "antitrust",
      "big tech", "tech platform", "content moderation", "section 230", "deepfake", "compute", "gpu", "open source"],
    urbanism: ["transit", "bus route", "railway", "subway", "light rail", "commuter", "commute", "traffic",
      "congestion", "pedestrian", "sidewalk", "crosswalk", "bike lane", "cyclist", "bicycle", "vision zero",
      "car free", "parking minimum", "sprawl", "walkable", "walkability", "transit oriented",
      "land use", "highway expansion", "road widening", "ridership", "headway",
      "bus rapid transit", "streetcar", "amtrak", "high speed rail", "ebike", "farebox", "busway"],
  };

  Seeds.DEMOGRAPHIC_TRIGGERS = {
    lgbtq: ["lgbt", "lgbtq", "queer", "gay", "lesbian", "trans", "transgender", "bisexual", "nonbinary",
      "pronoun", "genderaffirming", "gender affirming", "pride", "drag",
      "coming out", "chosen family", "conversion therapy", "bathroom bill", "name change", "deadname",
      "gender marker", "two spirit", "asexual", "intersex", "sapphic", "homophobia", "transphobia"],
    women: ["woman", "women", "feminist", "feminism", "girl", "girls", "mother", "mothers", "maternity",
      "childcare", "paygap", "pay gap", "harassment",
      "misogyny", "patriarchy", "domestic violence", "title ix", "glass ceiling", "caregiving", "motherhood",
      "menopause", "period poverty", "consent"],
    bipoc: ["black", "blacklives", "black lives", "asian", "latino", "latina", "latinx", "hispanic", "indigenous",
      "native", "tribal", "immigrantcommunity", "immigrant community", "diaspora",
      "aapi", "sovereignty", "treaty rights", "land back", "reservation", "colonialism", "xenophobia",
      "representation", "community of color", "bipoc"],
    veterans: ["veteran", "veterans", "soldier", "military", "va", "servicemember", "service member", "deployment",
      "gibill", "gi bill",
      "enlisted", "discharge", "ptsd", "burn pit", "tricare", "military family", "reservist", "national guard",
      "base housing", "va claim"],
    /* Both of these were missing entirely, which left the two spheres
       with nothing but their label and their member names to match on —
       a campaign about student debt could not find the young-voter
       audience because "student" was not in any of its vocabulary. */
    young_voters: ["young", "youth", "genz", "gen z", "zoomer", "millennial", "millennials", "teen", "teenager",
      "first time voter", "young people", "twenties", "undergrad", "dorm", "internship", "entry level",
      "student debt", "starting out", "next generation"],
    seniors: ["senior", "seniors", "elder", "elderly", "retiree", "retirees", "retired", "aging", "ageism",
      "nursing home", "assisted living", "eldercare", "grandparent", "grandchildren", "fixed income", "boomer",
      "aarp", "long term care", "hospice", "medigap", "medicare advantage"],
  };

  /* ---------- Helpers ---------- */

  /* Returns a flat, deduped list of canonical sub names from selected
   * sphere keys. */
  /* Human-readable labels for the picker dropdowns + chips. */
  Seeds.ISSUE_LABELS = {
    progressive:      "Progressive politics",
    movement:         "Activism / movement",
    healthcare:       "Healthcare",
    labor:            "Labor / unions",
    voting:           "Voting & elections",
    climate:          "Climate",
    reproductive:     "Reproductive rights",
    immigration:      "Immigration",
    education:        "Education",
    housing:          "Housing",
    palestine_gaza:   "Palestine / Gaza",
    racial_justice:   "Racial justice",
    media_news:       "Media & news",
    democracy:        "Democracy & rule of law",
    criminal_justice: "Criminal justice",
    gun_violence:     "Gun violence prevention",
    disability:       "Disability rights",
    safety_net:       "Social safety net",
    tech_privacy:     "Tech & digital rights",
    urbanism:         "Transit & land use",
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

  /* Deduped case-insensitively. Subreddit names are case-insensitive to
     Reddit, so a catalog that listed both "antifascistsofreddit" and
     "AntiFascistsOfReddit" — as this one did — asked the discovery
     pipeline to fetch and score the same community twice, and gave that
     community two votes in its sphere. */
  Seeds.expand = function (sphereKeys) {
    const out = new Map();
    for (const key of (sphereKeys || [])) {
      const lists = [
        Seeds.ISSUE_SPHERES[key] || [],
        Seeds.STATE_SPHERES[key] || [],
        Seeds.DEMOGRAPHIC_SPHERES[key] || [],
      ];
      for (const list of lists) {
        for (const s of list) if (!out.has(s.toLowerCase())) out.set(s.toLowerCase(), s);
      }
    }
    return Array.from(out.values());
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

  /* Spheres used to be "detected" here by testing whether a trigger word
   * appeared verbatim in the campaign's keywords, which made a sphere
   * either on or off with nothing in between and left it invisible when
   * the campaign said "renters" and the table said "tenant". The trigger
   * lists survive as vocabulary — Discovery.sphereProfiles folds them
   * into each sphere's term vector — but the ranking now happens in
   * Discovery.rankSpheres, which scores every sphere with a confidence
   * instead of picking the ones that happened to be spelled right. */

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
      spheres: ["climate", "urbanism"],
    },
    {
      key: "rule-of-law",
      label: "Democracy & courts",
      description: "Courts, oversight and anti-authoritarian organising, plus the communities tracking who is doing what.",
      spheres: ["democracy", "voting", "media_news"],
    },
    {
      key: "safety-and-dignity",
      label: "Safety net & disability",
      description: "Benefits, food assistance and disability rights — the communities where cuts land first.",
      spheres: ["safety_net", "disability", "healthcare"],
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
    const out = new Map();
    for (const map of [Seeds.ISSUE_SPHERES, Seeds.DEMOGRAPHIC_SPHERES, Seeds.STATE_SPHERES]) {
      for (const list of Object.values(map)) {
        for (const s of list) if (!out.has(s.toLowerCase())) out.set(s.toLowerCase(), s);
      }
    }
    return Array.from(out.values());
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
