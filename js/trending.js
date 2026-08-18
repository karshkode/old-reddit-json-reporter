/* ======================================================================
 * TRENDING — desk themes for campaigns (Recommend)
 * ----------------------------------------------------------------------
 * Semi-weekly progressive/civic keyword desks live here so Recommend can
 * lead with actionable themes: start a campaign, load issue spheres, or
 * open a matching Syndicate headline. Live headlines and inventory posts
 * are clustered under each topic when their text hits desk keywords.
 * ====================================================================== */

(function () {
  "use strict";

  const Trending = {};

  /* 18 Aug 2026 progressive / civic desk. Bump alongside
   * data/match/sphere-triggers.json when the news cycle shifts. */
  const DESK = [
    {
      id: "section-338-canada",
      label: "Section 338 Canada tariffs",
      blurb: "50% duties on ~$20B of Canadian goods take effect 19 Aug unless last-minute talks hold — first-ever use of Tariff Act §338, paid by U.S. importers into the midterm affordability fight.",
      spheres: ["economy_business", "labor", "progressive"],
      keywords: [
        "section 338", "canada tariff", "canadian tariffs", "50 percent tariff",
        "usmca", "import tax", "affordability", "cost of living", "trade war",
        "hockey sticks", "carney",
      ],
    },
    {
      id: "voter-rolls",
      label: "DOJ monitors & mail-in fights",
      blurb: "Civil expanded a 1,000-monitor midterm deployment while courts keep blocking the mail-in crackdown — voter-roll demands and 'rigged' framing stay the November story.",
      spheres: ["voting", "election_law", "democracy"],
      keywords: [
        "election monitor", "doj monitors", "voter roll", "voter rolls",
        "mail-in", "mail in ballot", "absentee", "election integrity",
        "midterm", "midterms", "voting rights", "save america act",
      ],
    },
    {
      id: "gaza-roadmap",
      label: "Gaza disarmament impasse",
      blurb: "Kushner left Jerusalem 17 Aug with no breakthrough: Netanyahu will not withdraw until Hamas disarms; new working groups lock reconstruction to demilitarization.",
      spheres: ["palestine_gaza", "civic_discussion", "media_news"],
      keywords: [
        "gaza", "kushner", "netanyahu", "disarmament", "demilitarization",
        "board of peace", "working group", "ceasefire", "hamas", "withdrawal",
        "15-point", "roadmap",
      ],
    },
    {
      id: "house-majority",
      label: "House majority & affordability",
      blurb: "Jeffries campaigns on prices into November; DSA energy and primary fights sit next to the House-majority math.",
      spheres: ["progressive", "voting", "movement"],
      keywords: [
        "jeffries", "hakeem jeffries", "affordability", "house majority",
        "democratic socialists", "dsa", "medicare for all", "blue wave",
        "primary challenger", "downballot",
      ],
    },
    {
      id: "doj-independence",
      label: "DOJ independence & Blanche",
      blurb: "Prosecutorial loyalty and a politicized Civil Rights Division stay on the desk as monitors and voter-roll cases scale up.",
      spheres: ["democracy", "civic_discussion", "election_law"],
      keywords: [
        "todd blanche", "attorney general", "doj independence", "justice department",
        "weaponized doj", "politicized prosecution", "civil rights division",
        "harmeet dhillon", "unitary executive",
      ],
    },
  ];

  Trending.desk = function () {
    return DESK.map((t) => Object.assign({}, t, { keywords: t.keywords.slice(), spheres: t.spheres.slice() }));
  };

  Trending.topicById = function (id) {
    const key = String(id || "");
    return Trending.desk().find((t) => t.id === key) || null;
  };

  function haystack(obj) {
    return [
      obj && obj.title,
      obj && obj.summary,
      obj && obj.selftext,
      obj && obj.body,
      obj && obj.source,
      obj && obj.flair,
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function scoreText(topic, text) {
    const blob = String(text || "").toLowerCase();
    if (!blob) return 0;
    let hits = 0;
    for (const kw of topic.keywords || []) {
      if (blob.indexOf(String(kw).toLowerCase()) !== -1) hits++;
    }
    return hits;
  }

  function scoreArticle(topic, article) {
    return scoreText(topic, haystack(article));
  }

  /* Inventory posts that read like this desk topic — candidates to fold
   * into a theme campaign without requiring same-URL copies. */
  Trending.matchingPosts = function (topic, posts, opts) {
    opts = opts || {};
    const list = Array.isArray(posts) ? posts : [];
    const scored = [];
    for (const p of list) {
      if (!p || !p.id) continue;
      if (p.syndicated || String(p.id).indexOf("art_") === 0) continue;
      const n = scoreText(topic, haystack(p));
      if (n <= 0) continue;
      scored.push({ post: p, hits: n });
    }
    scored.sort((a, b) => b.hits - a.hits || (b.post.score || 0) - (a.post.score || 0));
    return scored.slice(0, opts.limit || 12).map((x) => x.post);
  };

  Trending.existingCampaign = function (topic) {
    if (!topic || !window.Campaigns || !Campaigns.list) return null;
    const id = String(topic.id || "");
    const label = String(topic.label || "").toLowerCase();
    return Campaigns.list().find((c) => {
      const t = c && c.theme;
      if (!t) return false;
      if (t.kind === "trend" && id && t.id === id) return true;
      if (t.label && label && String(t.label).toLowerCase() === label) return true;
      return false;
    }) || null;
  };

  /* Cluster Syndicate headlines + inventory posts into desk topics. */
  Trending.aggregate = function (opts) {
    opts = opts || {};
    const articles = opts.articles
      || (window.Syndicate && Syndicate.articles ? Syndicate.articles() : [])
      || [];
    const posts = opts.posts
      || (window.AppState && Array.isArray(AppState.posts) ? AppState.posts : [])
      || [];
    const limitPer = opts.perTopic || 4;
    const topics = Trending.desk().map((topic) => {
      const scoredArts = [];
      for (const a of articles) {
        const n = scoreArticle(topic, a);
        if (n <= 0) continue;
        scoredArts.push({
          id: a.id,
          title: a.title,
          link: a.link,
          source: a.source || a.feedTitle || "",
          published: a.published || 0,
          hits: n,
        });
      }
      scoredArts.sort((a, b) => b.hits - a.hits || (b.published || 0) - (a.published || 0));
      const matchedPosts = Trending.matchingPosts(topic, posts, { limit: limitPer });
      let postPts = 0;
      let postComments = 0;
      let postSubs = new Set();
      for (const p of matchedPosts) {
        postPts += p.score || 0;
        postComments += p.num_comments || 0;
        if (p.subreddit) postSubs.add(String(p.subreddit).toLowerCase());
      }
      return {
        id: topic.id,
        label: topic.label,
        blurb: topic.blurb,
        spheres: topic.spheres,
        keywords: topic.keywords.slice(0, 6),
        headlines: scoredArts.slice(0, limitPer),
        hitCount: scoredArts.length,
        posts: matchedPosts,
        postCount: matchedPosts.length,
        postPts: postPts,
        postComments: postComments,
        postSubs: postSubs.size,
        desk: true,
        campaign: Trending.existingCampaign(topic),
      };
    });

    topics.sort((a, b) =>
      (b.hitCount + b.postCount) - (a.hitCount + a.postCount)
      || a.label.localeCompare(b.label)
    );
    return {
      updated: "2026-08-18",
      topics: topics,
      headlineCount: articles.length,
      postCount: posts.length,
    };
  };

  Trending.render = function (host, opts) {
    if (!host) return null;
    opts = opts || {};
    const data = Trending.aggregate(opts);
    const esc = (window.Util && Util.escapeHtml)
      ? (s) => Util.escapeHtml(s == null ? "" : String(s))
      : (s) => String(s == null ? "" : s);
    const fmt = (window.Util && Util.fmtNum) ? Util.fmtNum : String;

    if (!data.topics.length) {
      host.innerHTML = `<div class="empty"><strong>No trending desk yet</strong>
        <p>Pull Syndicate headlines or wait for the next lexicon update.</p></div>`;
      return data;
    }

    /* Top three themes first; the rest behind one tap. The desk sits
     * above the Recommend lists, so an always-expanded desk was most of
     * a phone screen before any post appeared. State lives on the host
     * so a refresh keeps the reader's choice. */
    const TRUNC = 3;
    const showAll = host.dataset.truncated === "false";
    const visible = (showAll || data.topics.length <= TRUNC)
      ? data.topics
      : data.topics.slice(0, TRUNC);
    host.dataset.truncated = (showAll || data.topics.length <= TRUNC) ? "false" : "true";
    const expanderHtml = data.topics.length > TRUNC
      ? (showAll
        ? `<button type="button" class="list-expand" data-action="trending-collapse">Show top ${TRUNC} only</button>`
        : `<button type="button" class="list-expand" data-action="trending-expand">Show all ${data.topics.length} themes</button>`)
      : "";

    host.innerHTML = `
      <div class="trending-meta meta">Desk of ${esc(data.updated)} · themes to campaign on${
        data.headlineCount
          ? ` · ${esc(String(data.headlineCount))} headline${data.headlineCount === 1 ? "" : "s"}`
          : ""
      }</div>
      <ul class="trending-list">
        ${visible.map((t) => {
          const camp = t.campaign;
          const materialBits = [];
          if (t.hitCount) materialBits.push(`${t.hitCount} article${t.hitCount === 1 ? "" : "s"}`);
          if (t.postCount) {
            materialBits.push(`${t.postCount} loaded post${t.postCount === 1 ? "" : "s"}`);
            if (t.postSubs) materialBits.push(`${t.postSubs} sub${t.postSubs === 1 ? "" : "s"}`);
            if (t.postPts) materialBits.push(`${fmt(t.postPts)} pts`);
            if (t.postComments) materialBits.push(`${fmt(t.postComments)} cmt`);
          }
          const topHead = t.headlines && t.headlines[0];
          return `
          <li class="trending-topic" data-trending="${esc(t.id)}">
            <div class="trending-topic-head">
              <h3 class="trending-topic-label">${esc(t.label)}</h3>
            </div>
            ${materialBits.length
              ? `<p class="meta trending-material">${esc(materialBits.join(" · "))}</p>`
              : `<p class="meta trending-empty">No matches yet</p>`}
            ${topHead ? `
              <p class="trending-lead">
                ${topHead.link
                  ? `<a href="${esc(topHead.link)}" target="_blank" rel="noopener noreferrer">${esc(topHead.title)}</a>`
                  : `<span>${esc(topHead.title)}</span>`}
                ${topHead.id ? `<button type="button" class="btn tiny ghost" data-action="trending-open-article" data-syn-id="${esc(topHead.id)}">Plan</button>` : ""}
              </p>` : ""}
            <div class="trending-topic-actions">
              ${camp
                ? `<button type="button" class="btn tiny" data-action="trending-open-campaign" data-campaign="${esc(camp.id)}">Open</button>`
                : `<button type="button" class="btn tiny primary" data-action="trending-make-campaign" data-trending="${esc(t.id)}"
                     title="Start a theme campaign — articles and matching posts fold in when available">+ Campaign</button>`}
              ${(t.spheres || []).length
                ? `<button type="button" class="btn tiny ghost" data-action="load-sphere-from-post" data-sphere="${esc(t.spheres[0])}">Load rooms</button>`
                : ""}
            </div>
            <details class="trending-more">
              <summary>Zoom in</summary>
              <p class="trending-topic-blurb">${esc(t.blurb)}</p>
              <div class="trending-topic-keys meta">${(t.keywords || []).map((k) => `<code>${esc(k)}</code>`).join(" ")}</div>
              <div class="trending-topic-spheres">
                ${(t.spheres || []).map((s) =>
                  `<button type="button" class="chip" data-action="load-sphere-from-post" data-sphere="${esc(s)}">${esc(s.replace(/_/g, " "))}</button>`
                ).join("")}
              </div>
              ${t.headlines && t.headlines.length > 1 ? `
              <ul class="trending-headlines">
                ${t.headlines.slice(1).map((h) => `
                  <li>
                    ${h.link
                      ? `<a href="${esc(h.link)}" target="_blank" rel="noopener noreferrer">${esc(h.title)}</a>`
                      : `<span>${esc(h.title)}</span>`}
                    ${h.source ? `<span class="meta"> · ${esc(h.source)}</span>` : ""}
                    ${h.id ? `<button type="button" class="btn tiny ghost" data-action="trending-open-article" data-syn-id="${esc(h.id)}">Plan</button>` : ""}
                  </li>`).join("")}
              </ul>` : ""}
            </details>
          </li>`;
        }).join("")}
      </ul>${expanderHtml}`;

    const expandBtn = host.querySelector('[data-action="trending-expand"], [data-action="trending-collapse"]');
    if (expandBtn) {
      expandBtn.addEventListener("click", () => {
        host.dataset.truncated = host.dataset.truncated === "true" ? "false" : "true";
        Trending.render(host, opts);
      });
    }
    return data;
  };

  /* Create (or reopen) a campaign for a desk topic id. */
  Trending.startCampaign = function (topicId, opts) {
    opts = opts || {};
    const topic = Trending.topicById(topicId);
    if (!topic) throw new Error("Unknown trend topic.");
    const existing = Trending.existingCampaign(topic);
    if (existing && !opts.force) return { campaign: existing, created: false };
    const agg = Trending.aggregate(opts);
    const rich = (agg.topics || []).find((t) => t.id === topic.id) || topic;
    if (!window.Campaigns || !Campaigns.fromTrend) throw new Error("Campaigns unavailable.");
    const campaign = Campaigns.fromTrend(rich, {
      posts: rich.posts || Trending.matchingPosts(topic, opts.posts || (window.AppState && AppState.posts) || []),
      name: opts.name,
    });
    return { campaign: campaign, created: true };
  };

  window.Trending = Trending;
})();
