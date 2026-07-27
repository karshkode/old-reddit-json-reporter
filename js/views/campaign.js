/* =====================================================================
 * CAMPAIGN VIEWS
 * ---------------------------------------------------------------------
 * Two routes:
 *
 *   #/campaigns        the list, plus cross-campaign tools
 *   #/campaign/<id>    the workspace for one campaign
 *
 * The workspace is the answer to the biggest structural gap in the
 * previous build: campaigns had goals, a post list and some prose, while
 * every chart in the app was hardwired to the globally-loaded post set.
 * A campaign now owns its own analytics at two levels — the campaign as
 * a whole, and each subreddit it touched, charted on that subreddit's
 * slice of the campaign's posts and benchmarked against the community's
 * wider behaviour when we have it loaded.
 * ===================================================================== */
(function () {
  const esc = (s) => Util.escapeHtml(s == null ? "" : s);
  const num = (n) => Util.fmtNum(n || 0);

  /* ==================================================================
   * CAMPAIGN LIST
   * ================================================================== */

  const ListView = {};

  ListView.render = function () {
    const host = Dom.byId("campaign-list");
    if (!host) return;
    const campaigns = Campaigns.list();

    if (!campaigns.length) {
      host.innerHTML = `<div class="card">${Dom.emptyState({
        icon: "◆",
        title: "No campaigns yet",
        body: "A campaign groups the cross-posts of one message so you can watch how each community responds. Create one from a post you already made, or paste the URLs of a set you have posted.",
        action: '<button class="btn primary" type="button" id="campaign-empty-new">Create your first campaign</button>',
      })}</div>`;
      return;
    }

    host.innerHTML = campaigns.map((c) => {
      const summary = AppState.campaignSummaries[c.id];
      const score = summary ? summary.totalScore : null;
      const comments = summary ? summary.totalComments : null;
      const subs = summary && summary.subs ? summary.subs : [];
      const scorePct = c.goalScore && score != null ? Math.min(100, (score / c.goalScore) * 100) : null;
      const commentPct = c.goalComments && comments != null ? Math.min(100, (comments / c.goalComments) * 100) : null;

      return `
        <button class="campaign-tile" type="button" data-view="campaign" data-view-id="${esc(c.id)}">
          <div class="campaign-tile-head">
            <span class="campaign-tile-name">${esc(c.name)}</span>
            <span class="badge">${c.postIds.length} post${c.postIds.length === 1 ? "" : "s"}</span>
          </div>
          <div class="campaign-tile-stats">
            <span><strong>${score == null ? "—" : num(score)}</strong> upvotes</span>
            <span><strong>${comments == null ? "—" : num(comments)}</strong> comments</span>
            <span><strong>${subs.length || "—"}</strong> sub${subs.length === 1 ? "" : "s"}</span>
          </div>
          ${scorePct != null ? `
            <div class="campaign-tile-goal">
              <div class="meta">${Math.round(scorePct)}% of ${num(c.goalScore)} upvote goal</div>
              <div class="meter"><span style="width:${scorePct.toFixed(1)}%"></span></div>
            </div>` : ""}
          ${commentPct != null ? `
            <div class="campaign-tile-goal">
              <div class="meta">${Math.round(commentPct)}% of ${num(c.goalComments)} comment goal</div>
              <div class="meter info"><span style="width:${commentPct.toFixed(1)}%"></span></div>
            </div>` : ""}
          ${subs.length ? `<div class="campaign-tile-subs">${subs.slice(0, 5).map((s) => `r/${esc(s)}`).join(" · ")}${subs.length > 5 ? ` +${subs.length - 5}` : ""}</div>` : ""}
        </button>`;
    }).join("");
  };

  ListView.mount = function () {
    const toggle = Dom.byId("campaign-new-toggle");
    const card = Dom.byId("campaign-new-card");
    const close = Dom.byId("campaign-new-close");
    function openForm(open) {
      if (!card) return;
      card.hidden = !open;
      if (open) {
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
        const name = Dom.byId("campaign-name");
        if (name) name.focus();
      }
    }
    if (toggle) toggle.addEventListener("click", () => openForm(card && card.hidden));
    if (close) close.addEventListener("click", () => openForm(false));
    Dom.delegate(document, "click", "#campaign-empty-new", () => openForm(true));
  };

  ListView.subtitle = function () {
    const n = Campaigns.list().length;
    return n ? `${n} saved campaign${n === 1 ? "" : "s"}` : "Nothing tracked yet";
  };

  Router.register("campaigns", {
    title: "Campaigns",
    subtitle: ListView.subtitle,
    mount: ListView.mount,
    render: ListView.render,
  });

  /* ==================================================================
   * CAMPAIGN WORKSPACE
   * ================================================================== */

  const Workspace = {};

  const SECTIONS = ["overview", "subreddits", "posts", "targeting", "plan", "settings"];

  Workspace.render = function (params) {
    const id = (params && params.id) || AppState.openCampaignId;
    const campaign = id ? Campaigns.get(id) : null;

    if (!campaign) {
      Dom.fill("camp-sec-overview", `<div class="card">${Dom.emptyState({
        icon: "◆",
        title: "Campaign not found",
        body: "It may have been deleted on this device, or the link points at another browser's data.",
        action: '<button class="btn" type="button" data-view="campaigns">Back to campaigns</button>',
      })}</div>`);
      return;
    }

    AppState.openCampaignId = campaign.id;

    const titleEl = Dom.byId("campaign-detail-title");
    if (titleEl) titleEl.textContent = campaign.name;

    const agg = AppState.campaignAgg && AppState.campaignAgg.campaignId === campaign.id
      ? AppState.campaignAgg
      : null;

    renderHeaderStats(campaign, agg);
    paintSectionRail();

    if (!agg) {
      /* Data is still resolving. Paint skeletons rather than an empty
       * frame so the layout does not jump when it lands. */
      Dom.fill("camp-sec-overview", `<div class="card">${Dom.skeleton(3, { chart: true })}</div>`);
      return;
    }

    renderSection(AppState.campaignSection || "overview", campaign, agg);
  };

  function renderHeaderStats(campaign, agg) {
    const metaEl = Dom.byId("campaign-workspace-meta");
    const kpiHost = Dom.byId("campaign-kpis");
    const goalHost = Dom.byId("campaign-goals");
    const alertHost = Dom.byId("campaign-alerts");

    if (metaEl) {
      const created = campaign.createdAt ? Util.relTime(campaign.createdAt / 1000) : "";
      metaEl.textContent = `${campaign.postIds.length} tracked post${campaign.postIds.length === 1 ? "" : "s"}${created ? ` · started ${created}` : ""}`;
    }

    if (kpiHost) {
      if (!agg) {
        kpiHost.innerHTML = Dom.skeleton(2);
      } else {
        const subs = agg.subs || [];
        kpiHost.innerHTML = `
          <div class="stat">
            <div class="stat-label">Posts resolved</div>
            <div class="stat-value">${num(agg.posts.length)}</div>
            <div class="stat-sub">${campaign.postIds.length} tracked${agg.missing && agg.missing.length ? ` · ${agg.missing.length} unresolved` : ""}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Upvotes</div>
            <div class="stat-value">${num(agg.totalScore)}</div>
            <div class="stat-sub">${campaign.goalScore ? Math.round((agg.totalScore / campaign.goalScore) * 100) + "% of goal" : "no goal set"}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Comments</div>
            <div class="stat-value">${num(agg.totalComments)}</div>
            <div class="stat-sub">${campaign.goalComments ? Math.round((agg.totalComments / campaign.goalComments) * 100) + "% of goal" : "no goal set"}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Subreddits</div>
            <div class="stat-value">${subs.length}</div>
            <div class="stat-sub" title="${esc(subs.map((s) => "r/" + s).join(", "))}">${subs.length ? esc(subs.slice(0, 3).map((s) => "r/" + s).join(", ")) + (subs.length > 3 ? ` +${subs.length - 3}` : "") : "—"}</div>
          </div>`;
      }
    }

    if (goalHost) {
      const bars = [];
      if (campaign.goalScore && agg) {
        const pct = Math.min(100, (agg.totalScore / campaign.goalScore) * 100);
        bars.push(goalBar("Upvotes", agg.totalScore, campaign.goalScore, pct, ""));
      }
      if (campaign.goalComments && agg) {
        const pct = Math.min(100, (agg.totalComments / campaign.goalComments) * 100);
        bars.push(goalBar("Comments", agg.totalComments, campaign.goalComments, pct, "info"));
      }
      goalHost.innerHTML = bars.length ? `<div class="campaign-goalbars">${bars.join("")}</div>` : "";
    }

    if (alertHost) alertHost.innerHTML = agg ? renderUnresolved(agg) : "";
  }

  function goalBar(label, value, goal, pct, variant) {
    return `
      <div class="campaign-goalbar">
        <div class="campaign-goalbar-head">
          <span>${esc(label)}</span>
          <span>${num(value)} / ${num(goal)} · <strong>${Math.round(pct)}%</strong></span>
        </div>
        <div class="meter ${variant}"><span style="width:${pct.toFixed(1)}%"></span></div>
      </div>`;
  }

  function renderUnresolved(agg) {
    if (!agg.missing || !agg.missing.length) return "";
    const allMissing = agg.posts.length === 0;
    const reason = allMissing && agg.networkError
      ? `<div class="meta err"><strong>Couldn't reach Reddit:</strong> ${esc(agg.networkError)}. Try Refresh, or switch the proxy in Settings.</div>`
      : "";
    const chips = agg.missing.map((id) => `
      <span class="unresolved-chip" data-id="${esc(id)}">
        <code>${esc(id)}</code>
        <button type="button" class="unresolved-chip-remove" data-action="remove-post" data-id="${esc(id)}" aria-label="Remove ${esc(id)}">×</button>
      </span>`).join("");
    return `<div class="banner warn">${reason}
      <div class="unresolved-list">
        <span class="unresolved-list-label">${allMissing && agg.networkError ? "Unresolved IDs" : "Could not resolve"}:</span>
        <span class="unresolved-list-chips">${chips}</span>
        <span class="hint">tap × to drop a post from the campaign</span>
      </div></div>`;
  }

  function paintSectionRail() {
    const active = AppState.campaignSection || "overview";
    for (const btn of Dom.$$("#campaign-section-rail [data-campaign-tab]")) {
      btn.classList.toggle("active", btn.dataset.campaignTab === active);
    }
    for (const sec of Dom.$$("#view-campaign .campaign-section")) {
      sec.classList.toggle("active", sec.id === "camp-sec-" + active);
    }
  }

  function renderSection(section, campaign, agg) {
    paintSectionRail();
    if (section === "overview") return renderOverview(campaign, agg);
    if (section === "subreddits") return renderSubreddits(campaign, agg);
    if (section === "posts") return renderPosts(campaign, agg);
    if (section === "targeting") return renderTargeting(campaign, agg);
    if (section === "settings") return renderSettings(campaign, agg);
    /* Plan is static markup wired by app.js. */
  }

  /* ------------------------------------------------------------------
   * OVERVIEW — the campaign as one dataset
   * ------------------------------------------------------------------ */

  function renderOverview(campaign, agg) {
    const host = Dom.byId("camp-sec-overview");
    if (!host) return;
    const posts = agg.posts || [];

    if (!posts.length) {
      host.innerHTML = `<div class="card">${Dom.emptyState({
        icon: "◆",
        title: "No posts resolved yet",
        body: "Add the Reddit URLs of the posts in this campaign and they will be fetched and analysed. Mobile share links work too.",
        action: '<button class="btn primary" type="button" data-campaign-goto="posts">Add posts</button>',
      })}</div>`;
      return;
    }

    Charts.destroyIn(host);

    const deep = AppState.campaignDeep;
    const bundle = Analysis.dashboard(posts, { window: "all", label: campaign.name });

    host.innerHTML = `
      ${deep && deep.narrative ? `
        <div class="card">
          <header class="card-header"><div><h2>How this campaign is doing</h2><span class="hint">Read from your campaign's own posts</span></div></header>
          <div class="prose">${deep.narrative}</div>
        </div>` : ""}

      <div class="grid two" style="margin-top:var(--s-4)">
        <div class="card span-2">
          <header class="card-header">
            <div><h2>Campaign activity over time</h2><span class="hint">One line per subreddit this campaign posted into</span></div>
          </header>
          <div class="chart-wrap tall" data-chart="timeline"><canvas></canvas></div>
        </div>
        <div class="card">
          <header class="card-header"><div><h2>Score vs comments</h2><span class="hint">Which posts converted attention into discussion</span></div></header>
          <div class="chart-wrap" data-chart="scatter"><canvas></canvas></div>
        </div>
        <div class="card">
          <header class="card-header"><div><h2>Tone of your titles</h2><span class="hint">Lexicon-scored across the campaign</span></div></header>
          <div class="chart-wrap" data-chart="sentiment"><canvas></canvas></div>
        </div>
        <div class="card">
          <header class="card-header"><div><h2>Best hours for this campaign</h2><span class="hint">Average upvotes by hour, your local time</span></div></header>
          <div class="chart-wrap" data-chart="hour"><canvas></canvas></div>
        </div>
        <div class="card">
          <header class="card-header"><div><h2>Score spread</h2><span class="hint">How evenly the campaign performed</span></div></header>
          <div class="chart-wrap" data-chart="hist"><canvas></canvas></div>
        </div>
      </div>

      ${deep && deep.comparison ? renderComparison(deep.comparison) : ""}
      ${bundle.profile ? renderProfileCard(bundle) : ""}`;

    const mount = (sel, kind, data, opts) => {
      const wrap = host.querySelector(`[data-chart="${sel}"]`);
      if (wrap) Charts.mount(wrap, { kind: kind, data: data, opts: opts });
    };

    mount("timeline", "timeline", Analysis.bucketByTimePerSub(posts, { window: "all" }), { mode: "lines" });
    mount("scatter", "scatter", posts);
    mount("sentiment", "sentiment", bundle.sentiment);
    mount("hour", "hourHeat", bundle.agg);
    mount("hist", "histogram", bundle.histogram);
  }

  function renderComparison(cmp) {
    if (!cmp || !cmp.insights || !cmp.insights.length) return "";
    return `
      <div class="card" style="margin-top:var(--s-4)">
        <header class="card-header"><div><h2>What separates your best posts from your worst</h2><span class="hint">Top third versus bottom third</span></div></header>
        <ul class="reco-list">${cmp.insights.map((i) => `<li>${i}</li>`).join("")}</ul>
      </div>`;
  }

  function renderProfileCard(bundle) {
    const p = bundle.profile;
    if (!p) return "";
    const kw = (bundle.keywords || []).slice(0, 12);
    return `
      <div class="card" style="margin-top:var(--s-4)">
        <header class="card-header"><div><h2>Campaign fingerprint</h2><span class="hint">The signature this campaign presents to a new community</span></div></header>
        <div class="row gap wrap" style="margin-bottom:var(--s-3)">
          ${p.style ? `<span class="badge accent">${esc(p.style)}</span>` : ""}
          ${p.reception ? `<span class="badge ${p.reception === "warm" ? "good" : p.reception === "contentious" ? "bad" : "info"}">${esc(p.reception)}</span>` : ""}
          ${bundle.trend && bundle.trend.direction ? `<span class="badge ${bundle.trend.direction === "rising" ? "good" : bundle.trend.direction === "declining" ? "bad" : ""}">${esc(bundle.trend.direction)}</span>` : ""}
        </div>
        <div class="stat-strip">
          <div><div class="stat-label">Median score</div><div class="stat-value">${num(bundle.agg.medianScore)}</div></div>
          <div><div class="stat-label">Avg comments</div><div class="stat-value">${num(Math.round(bundle.agg.avgComments || 0))}</div></div>
          <div><div class="stat-label">Avg upvote ratio</div><div class="stat-value">${bundle.agg.avgUpvoteRatio != null ? Util.fmtPct(bundle.agg.avgUpvoteRatio) : "—"}</div></div>
          <div><div class="stat-label">Peak hour</div><div class="stat-value">${p.peakHour != null ? p.peakHour + ":00" : "—"}</div></div>
        </div>
        ${kw.length ? `<div class="keyword-cloud" style="margin-top:var(--s-3)">${kw.map((k) => `<span class="kw">${esc(k.word)}<span class="count">${k.count}</span></span>`).join("")}</div>` : ""}
      </div>`;
  }

  /* ------------------------------------------------------------------
   * SUBREDDITS — per-community trend analysis
   * ------------------------------------------------------------------ */

  function renderSubreddits(campaign, agg) {
    const posts = agg.posts || [];
    const cardHost = Dom.byId("campaign-sub-cards");
    const tableHost = Dom.byId("campaign-sub-table");
    const compareWrap = Dom.byId("campaign-sub-compare-wrap");

    if (!posts.length) {
      if (cardHost) cardHost.innerHTML = "";
      if (tableHost) {
        tableHost.innerHTML = Dom.emptyState({
          icon: "⌗",
          title: "Nothing to chart yet",
          body: "Once this campaign has resolved posts, each subreddit it reached gets its own trend panel here.",
        });
      }
      if (compareWrap) compareWrap.hidden = true;
      return;
    }

    const win = AppState.campaignSubWindow || "all";
    const perSub = Analysis.perSubredditDashboards(posts, { window: win, sortBy: "score" });

    /* Cross-sub comparison first: the question "which community carried
     * this" should be answerable before scrolling through the detail. */
    if (compareWrap) {
      compareWrap.hidden = perSub.length < 2;
      if (perSub.length >= 2) {
        Charts.hbar("chart-campaign-subs", {
          labels: perSub.map((s) => "r/" + s.subreddit),
          values: perSub.map((s) => s.agg.totalScore),
          secondary: perSub.map((s) => s.agg.totalComments),
        }, { label: "Upvotes", secondaryLabel: "Comments" });
      }
    }

    if (tableHost) tableHost.innerHTML = renderSubTable(perSub, posts.length);

    if (!cardHost) return;
    Charts.destroyIn(cardHost);
    cardHost.innerHTML = perSub.map((sub) => renderSubCard(sub, campaign)).join("");

    for (const sub of perSub) {
      const card = cardHost.querySelector(`[data-sub-card="${esc(sub.key)}"]`);
      if (!card) continue;
      const timelineWrap = card.querySelector('[data-chart="timeline"]');
      if (timelineWrap) {
        Charts.mount(timelineWrap, {
          kind: "timeline",
          data: Analysis.bucketByTimePerSub(sub.posts, { window: win }),
          opts: { mode: "total" },
        });
      }
      const hourWrap = card.querySelector('[data-chart="hour"]');
      if (hourWrap) Charts.mount(hourWrap, { kind: "hourHeat", data: sub.agg });
    }
  }

  function renderSubTable(perSub, totalPosts) {
    if (!perSub.length) return "";
    return `
      <div class="table-wrap" style="margin-top:var(--s-3)">
        <table class="data">
          <thead>
            <tr>
              <th>Subreddit</th>
              <th class="num">Posts</th>
              <th class="num">Upvotes</th>
              <th class="num">Comments</th>
              <th class="num">Avg score</th>
              <th class="num">UV %</th>
              <th class="num">Share</th>
              <th>Trend</th>
            </tr>
          </thead>
          <tbody>
            ${perSub.map((s) => {
              const share = totalPosts ? (s.count / totalPosts) * 100 : 0;
              const dir = s.trend && s.trend.direction;
              return `<tr>
                <td><strong>r/${esc(s.subreddit)}</strong></td>
                <td class="num">${num(s.count)}</td>
                <td class="num">${num(s.agg.totalScore)}</td>
                <td class="num">${num(s.agg.totalComments)}</td>
                <td class="num">${num(Math.round(s.agg.avgScore || 0))}</td>
                <td class="num">${s.agg.avgUpvoteRatio != null ? Util.fmtPct(s.agg.avgUpvoteRatio) : "—"}</td>
                <td class="num">${share.toFixed(0)}%</td>
                <td>${dir ? `<span class="badge ${dir === "rising" ? "good" : dir === "declining" ? "bad" : ""}">${esc(dir)}</span>` : "—"}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  }

  /* One card per community. The value here is the comparison: how this
   * campaign's posts did in this sub, against how the sub normally
   * behaves — which we can answer whenever the sub is also loaded on the
   * dashboard. */
  function renderSubCard(sub, campaign) {
    const profile = AppState.subProfiles[sub.key];
    const benchmark = profile && profile.count >= 3 ? profile : null;
    const avgScore = Math.round(sub.agg.avgScore || 0);

    let benchmarkHtml = "";
    if (benchmark) {
      const subMedian = benchmark.medianScore != null
        ? benchmark.medianScore
        : (benchmark.agg && benchmark.agg.medianScore);
      if (subMedian != null && subMedian > 0) {
        const ratio = avgScore / subMedian;
        const verdict = ratio >= 1.5 ? "good" : ratio >= 0.8 ? "info" : "bad";
        const wording = ratio >= 1.5 ? "well above" : ratio >= 0.8 ? "in line with" : "below";
        benchmarkHtml = `
          <div class="sub-card-benchmark">
            <span class="badge ${verdict}">${(ratio).toFixed(1)}×</span>
            Your average of <strong>${num(avgScore)}</strong> is ${wording} this sub's typical post (median ${num(subMedian)} across ${num(benchmark.count)} loaded posts).
          </div>`;
      }
    } else {
      benchmarkHtml = `
        <div class="sub-card-benchmark muted">
          No benchmark yet — ${AppState.hasSub(sub.subreddit)
            ? "load this sub's posts with <strong>Go</strong> to compare against its typical performance."
            : `<button class="btn tiny" type="button" data-action="add-sub" data-sub="${esc(sub.subreddit)}">＋ Add r/${esc(sub.subreddit)}</button> to benchmark against its typical performance.`}
        </div>`;
    }

    const kw = (sub.keywords || []).slice(0, 6);
    const dir = sub.trend && sub.trend.direction;
    const best = bestPost(sub.posts);

    return `
      <div class="card sub-card" data-sub-card="${esc(sub.key)}">
        <header class="card-header">
          <div>
            <h2>r/${esc(sub.subreddit)}</h2>
            <span class="hint">${num(sub.count)} campaign post${sub.count === 1 ? "" : "s"}${sub.agg.peakHour != null ? ` · peaks at ${sub.agg.peakHour}:00` : ""}</span>
          </div>
          <div class="card-actions">
            ${dir ? `<span class="badge ${dir === "rising" ? "good" : dir === "declining" ? "bad" : ""}">${esc(dir)}</span>` : ""}
            <a class="btn tiny ghost" href="https://www.reddit.com/r/${encodeURIComponent(sub.subreddit)}/" target="_blank" rel="noopener">Open ↗</a>
          </div>
        </header>

        <div class="stat-strip sub-card-stats">
          <div><div class="stat-label">Upvotes</div><div class="stat-value">${num(sub.agg.totalScore)}</div></div>
          <div><div class="stat-label">Comments</div><div class="stat-value">${num(sub.agg.totalComments)}</div></div>
          <div><div class="stat-label">Avg score</div><div class="stat-value">${num(avgScore)}</div></div>
          <div><div class="stat-label">UV ratio</div><div class="stat-value">${sub.agg.avgUpvoteRatio != null ? Util.fmtPct(sub.agg.avgUpvoteRatio) : "—"}</div></div>
        </div>

        ${benchmarkHtml}

        <div class="sub-card-charts">
          <div class="chart-panel">
            <div class="chart-panel-title">Posting cadence</div>
            <div class="chart-wrap short" data-chart="timeline"><canvas></canvas></div>
          </div>
          <div class="chart-panel">
            <div class="chart-panel-title">Score by hour</div>
            <div class="chart-wrap short" data-chart="hour"><canvas></canvas></div>
          </div>
        </div>

        ${best ? `
          <div class="sub-card-best">
            <span class="stat-label">Best performer</span>
            <a href="${esc(best.permalink)}" target="_blank" rel="noopener">${esc((best.title || "").slice(0, 110))}</a>
            <span class="meta">▲ ${num(best.score)} · 💬 ${num(best.num_comments)}</span>
          </div>` : ""}

        ${kw.length ? `<div class="keyword-cloud">${kw.map((k) => `<span class="kw">${esc(k.word)}<span class="count">${k.count}</span></span>`).join("")}</div>` : ""}
      </div>`;
  }

  function bestPost(posts) {
    return (posts || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;
  }

  /* ------------------------------------------------------------------
   * POSTS
   * ------------------------------------------------------------------ */

  function renderPosts(campaign, agg) {
    const host = Dom.byId("camp-sec-posts");
    if (!host) return;
    const posts = (agg.posts || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0));

    host.innerHTML = `
      <div class="card">
        <header class="card-header">
          <div><h2>Add posts</h2><span class="hint">Paste Reddit URLs, mobile share links, or bare IDs — anything from your phone works</span></div>
        </header>
        <div class="add-posts-form" data-campaign-id="${esc(campaign.id)}">
          <textarea data-role="add-posts-textarea" rows="2" placeholder="https://www.reddit.com/r/…/comments/abc123/title/&#10;https://www.reddit.com/r/…/s/AbCdEf1234"></textarea>
          <div class="paste-preview" data-role="add-posts-preview" hidden></div>
          <div class="add-posts-status" data-role="add-posts-status" hidden></div>
          <div class="add-posts-row">
            <button class="btn small ghost" type="button" data-action="add-posts-paste" title="Pull a Reddit URL from your clipboard">📋 Paste</button>
            <button class="btn small primary" type="button" data-action="add-posts">Add posts</button>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:var(--s-4)">
        <header class="card-header">
          <div><h2>Tracked posts (${num(posts.length)})</h2><span class="hint">Sorted by score</span></div>
        </header>
        ${posts.length ? `<div class="campaign-posts">${posts.map(renderPostRow).join("")}</div>`
          : Dom.emptyState({ icon: "≡", title: "No resolved posts", body: "Add some URLs above to start tracking." })}
      </div>`;
  }

  function renderPostRow(p) {
    return `
      <div class="campaign-post-row">
        <a href="${esc(p.permalink)}" target="_blank" rel="noopener" class="campaign-post-link">
          <div class="cpr-title">${esc((p.title || "").slice(0, 140))}</div>
          <div class="cpr-meta">r/${esc(p.subreddit)} · <code>${esc(p.id)}</code> · ${esc(Util.relTime(p.created_utc))}</div>
        </a>
        <div class="cpr-stats">
          <strong class="cpr-score">▲ ${num(p.score)}</strong>
          <span>💬 ${num(p.num_comments)}</span>
          ${p.upvote_ratio != null ? `<span>${Util.fmtPct(p.upvote_ratio)}</span>` : ""}
        </div>
        <button class="cpr-remove" type="button" data-action="remove-post" data-id="${esc(p.id)}" title="Remove from campaign" aria-label="Remove from campaign">×</button>
      </div>`;
  }

  /* ------------------------------------------------------------------
   * TARGETING — the section markup is static; this fills the "best fits
   * among loaded subs" list and keeps the hidden campaign select in
   * step with whichever campaign is open.
   * ------------------------------------------------------------------ */

  function renderTargeting(campaign, agg) {
    /* The discovery pipeline reads its campaign from this control. It is
     * visually hidden because the workspace already establishes which
     * campaign we are in; app.js owns its options. */
    const select = Dom.byId("discover-campaign");
    if (select) select.value = campaign.id;

    const deep = AppState.campaignDeep;
    const host = Dom.byId("campaign-detail-targets");
    if (!host) return;

    if (!deep || !deep.targets || !deep.targets.length) {
      host.innerHTML = Dom.emptyState({
        icon: "◎",
        title: "No loaded subreddits to rank yet",
        body: "This list ranks the subs already in your dashboard by how well they fit this campaign. Load some posts with <strong>Go</strong>, or use <strong>Find subreddits</strong> above to discover new ones.",
      });
      return;
    }

    App.renderTargetingInto("campaigns", campaign, deep.targets, host, {
      bestCampaignPost: bestPost(agg.posts),
    });
  }

  /* ------------------------------------------------------------------
   * SETTINGS
   * ------------------------------------------------------------------ */

  function renderSettings(campaign, agg) {
    const host = Dom.byId("camp-sec-settings");
    if (!host) return;
    host.innerHTML = `
      <div class="card">
        <header class="card-header"><div><h2>Goals</h2><span class="hint">Progress bars appear on the campaign header and list</span></div></header>
        <form class="form-grid goals-edit-form" data-campaign-id="${esc(campaign.id)}">
          <label>Goal upvotes
            <input type="number" min="0" data-field="goalScore" value="${campaign.goalScore || ""}" placeholder="e.g. 5000" inputmode="numeric" />
          </label>
          <label>Goal comments
            <input type="number" min="0" data-field="goalComments" value="${campaign.goalComments || ""}" placeholder="e.g. 500" inputmode="numeric" />
          </label>
          <div class="full row-end"><button class="btn primary" type="submit">Save goals</button></div>
        </form>
      </div>

      <div class="card" style="margin-top:var(--s-4)">
        <header class="card-header"><div><h2>Share a digest</h2><span class="hint">Plain text you can paste into a group chat</span></div></header>
        <button class="btn" type="button" data-action="copy-campaign-digest" data-campaign-id="${esc(campaign.id)}">📋 Copy digest</button>
      </div>

      <div class="card" style="margin-top:var(--s-4)">
        <header class="card-header"><div><h2>Danger zone</h2><span class="hint">Removing a campaign does not touch the posts on Reddit</span></div></header>
        <button class="btn danger" type="button" data-action="delete-campaign">Delete this campaign</button>
      </div>`;
  }

  /* ------------------------------------------------------------------
   * Wiring
   * ------------------------------------------------------------------ */

  Workspace.mount = function () {
    Dom.delegate(document, "click", "#campaign-section-rail [data-campaign-tab]", (e, btn) => {
      Workspace.goToSection(btn.dataset.campaignTab);
    });
    Dom.delegate(document, "click", "[data-campaign-goto]", (e, btn) => {
      Workspace.goToSection(btn.dataset.campaignGoto);
    });
    Dom.delegate(document, "click", "#campaign-sub-window button", (e, btn) => {
      AppState.campaignSubWindow = btn.dataset.window;
      for (const sib of btn.parentElement.children) sib.classList.toggle("active", sib === btn);
      const campaign = Campaigns.get(AppState.openCampaignId);
      if (campaign && AppState.campaignAgg) renderSubreddits(campaign, AppState.campaignAgg);
    });
    Dom.delegate(document, "click", '[data-action="add-sub"]', (e, btn) => {
      const added = AppState.addSubs([btn.dataset.sub]);
      App.renderChips();
      App.markPending();
      Util.toast(added.length ? `Added r/${btn.dataset.sub} — tap Go to load it` : `r/${btn.dataset.sub} is already in your dashboard`);
    });
    Dom.delegate(document, "click", '[data-action="delete-campaign"]', () => {
      const campaign = Campaigns.get(AppState.openCampaignId);
      if (!campaign) return;
      if (!confirm(`Delete "${campaign.name}"? This cannot be undone.`)) return;
      Campaigns.remove(campaign.id);
      AppState.openCampaignId = null;
      Router.invalidate(["campaigns"]);
      Router.go("campaigns");
    });
  };

  Workspace.goToSection = function (section) {
    if (SECTIONS.indexOf(section) < 0) return;
    AppState.campaignSection = section;
    const campaign = Campaigns.get(AppState.openCampaignId);
    if (campaign && AppState.campaignAgg) renderSection(section, campaign, AppState.campaignAgg);
    else paintSectionRail();
  };

  Workspace.title = function (params) {
    const campaign = Campaigns.get((params && params.id) || AppState.openCampaignId);
    return campaign ? campaign.name : "Campaign";
  };

  Router.register("campaign", {
    title: Workspace.title,
    subtitle: "Campaign workspace",
    mount: Workspace.mount,
    render: Workspace.render,
    enter: function (params) {
      const id = params && params.id;
      if (id && id !== (AppState.campaignAgg && AppState.campaignAgg.campaignId)) {
        App.loadCampaign(id);
      }
    },
  });

  window.CampaignView = Workspace;
  window.CampaignListView = ListView;
})();
