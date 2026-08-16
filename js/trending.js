/* ======================================================================
 * TRENDING — desk topics + live Syndicate headline clusters
 * ----------------------------------------------------------------------
 * Semi-weekly progressive/civic keyword desks are curated here so Trends
 * and Recommend can surface big stories even when the loaded inventory
 * has not caught up. Live headlines from Syndicate are folded into the
 * same topic buckets when their titles hit the desk keywords.
 * ====================================================================== */

(function () {
  "use strict";

  const Trending = {};

  /* Mid-Aug 2026 progressive / civic desk. Bump alongside
   * data/match/sphere-triggers.json when the news cycle shifts. */
  const DESK = [
    {
      id: "doj-independence",
      label: "DOJ independence & Blanche",
      blurb: "Attorney General Todd Blanche declines a hard independence pledge; prosecutorial loyalty stays in the news cycle.",
      spheres: ["democracy", "civic_discussion", "election_law"],
      keywords: [
        "todd blanche", "attorney general", "doj independence", "justice department",
        "weaponized doj", "politicized prosecution", "meet the press", "unitary executive",
      ],
    },
    {
      id: "voter-rolls",
      label: "Voter rolls & midterms",
      blurb: "DOJ keeps pressing states for voter-registration data ahead of November despite a long string of court losses.",
      spheres: ["voting", "election_law", "democracy"],
      keywords: [
        "voter roll", "voter rolls", "voter registration", "election integrity",
        "midterm", "midterms", "2026 election", "title iii", "voting rights",
      ],
    },
    {
      id: "forever-tariffs",
      label: "Forever tariffs & prices",
      blurb: "Long-haul Section 301 / 232 import taxes land on consumers; affordability becomes a midterm frame.",
      spheres: ["economy_business", "labor", "progressive"],
      keywords: [
        "tariff", "tariffs", "forever tariff", "section 301", "section 232",
        "import tax", "affordability", "cost of living", "canada tariff", "trade war",
      ],
    },
    {
      id: "gaza-roadmap",
      label: "Gaza roadmap talks",
      blurb: "Kushner–Hamas contacts and a proposed disarmament roadmap collide with Netanyahu’s rejection.",
      spheres: ["palestine_gaza", "civic_discussion", "media_news"],
      keywords: [
        "gaza", "kushner", "hamas", "roadmap", "road map", "ceasefire",
        "board of peace", "disarmament", "netanyahu", "west bank",
      ],
    },
    {
      id: "house-majority",
      label: "House majority path",
      blurb: "Leadership distances from the DSA left while progressives push affordability and primary energy.",
      spheres: ["progressive", "voting", "movement"],
      keywords: [
        "jeffries", "democratic socialists", "dsa", "medicare for all",
        "house majority", "blue wave", "primary challenger", "downballot",
      ],
    },
  ];

  Trending.desk = function () {
    return DESK.map((t) => Object.assign({}, t, { keywords: t.keywords.slice(), spheres: t.spheres.slice() }));
  };

  function haystack(article) {
    return [article && article.title, article && article.summary, article && article.source]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function scoreArticle(topic, article) {
    const text = haystack(article);
    if (!text) return 0;
    let hits = 0;
    for (const kw of topic.keywords) {
      if (text.indexOf(String(kw).toLowerCase()) !== -1) hits++;
    }
    return hits;
  }

  /* Cluster Syndicate headlines into desk topics. Unmatched headlines that
   * still look political can form an "Other desk" bucket when there are
   * enough of them. */
  Trending.aggregate = function (opts) {
    opts = opts || {};
    const articles = opts.articles
      || (window.Syndicate && Syndicate.articles ? Syndicate.articles() : [])
      || [];
    const limitPer = opts.perTopic || 4;
    const topics = Trending.desk().map((topic) => {
      const scored = [];
      for (const a of articles) {
        const n = scoreArticle(topic, a);
        if (n <= 0) continue;
        scored.push({
          id: a.id,
          title: a.title,
          link: a.link,
          source: a.source || a.feedTitle || "",
          published: a.published || 0,
          hits: n,
        });
      }
      scored.sort((a, b) => b.hits - a.hits || (b.published || 0) - (a.published || 0));
      return {
        id: topic.id,
        label: topic.label,
        blurb: topic.blurb,
        spheres: topic.spheres,
        keywords: topic.keywords.slice(0, 6),
        headlines: scored.slice(0, limitPer),
        hitCount: scored.length,
        desk: true,
      };
    });

    /* Prefer topics that either have live headlines or are the curated desk. */
    topics.sort((a, b) => (b.hitCount - a.hitCount) || a.label.localeCompare(b.label));
    return {
      updated: "2026-08-16",
      topics: topics,
      headlineCount: articles.length,
    };
  };

  Trending.render = function (host, opts) {
    if (!host) return null;
    opts = opts || {};
    const data = Trending.aggregate(opts);
    const esc = (window.Util && Util.escapeHtml)
      ? (s) => Util.escapeHtml(s == null ? "" : String(s))
      : (s) => String(s == null ? "" : s);

    if (!data.topics.length) {
      host.innerHTML = `<div class="empty"><strong>No trending desk yet</strong>
        <p>Pull Syndicate headlines or wait for the next lexicon update.</p></div>`;
      return data;
    }

    host.innerHTML = `
      <div class="trending-meta meta">Desk of ${esc(data.updated)}${
        data.headlineCount
          ? ` · ${esc(String(data.headlineCount))} headline${data.headlineCount === 1 ? "" : "s"} in cache`
          : " · pull articles to fill live clusters"
      }</div>
      <ul class="trending-list">
        ${data.topics.map((t) => `
          <li class="trending-topic" data-trending="${esc(t.id)}">
            <div class="trending-topic-head">
              <h3 class="trending-topic-label">${esc(t.label)}</h3>
              <div class="trending-topic-spheres">
                ${(t.spheres || []).map((s) =>
                  `<button type="button" class="chip" data-action="load-sphere-from-post" data-sphere="${esc(s)}">${esc(s.replace(/_/g, " "))}</button>`
                ).join("")}
              </div>
            </div>
            <p class="trending-topic-blurb">${esc(t.blurb)}</p>
            <div class="trending-topic-keys meta">${(t.keywords || []).map((k) => `<code>${esc(k)}</code>`).join(" ")}</div>
            ${t.headlines && t.headlines.length ? `
              <ul class="trending-headlines">
                ${t.headlines.map((h) => `
                  <li>
                    ${h.link
                      ? `<a href="${esc(h.link)}" target="_blank" rel="noopener noreferrer">${esc(h.title)}</a>`
                      : `<span>${esc(h.title)}</span>`}
                    ${h.source ? `<span class="meta"> · ${esc(h.source)}</span>` : ""}
                  </li>`).join("")}
              </ul>` : `<p class="meta trending-empty">No matching headlines in the current pull — keywords still seed Recommend search.</p>`}
          </li>`).join("")}
      </ul>`;
    return data;
  };

  window.Trending = Trending;
})();
