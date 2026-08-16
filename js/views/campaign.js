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

  function trunc(s, n) {
    const t = String(s == null ? "" : s);
    return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
  }
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
      host.innerHTML = `<div class="card campaign-empty">${Dom.emptyState({
        icon: "◆",
        title: "No campaigns yet",
        body: "A campaign is a theme you post on — a desk trend, a Syndicate headline, an origin post, or an aggregated set of related material. Create one from Recommend themes, an article, or a loaded post.",
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
      const themeKind = c.theme && Campaigns.themeKindLabel ? Campaigns.themeKindLabel(c.theme) : "";
      const themeLabel = c.theme && c.theme.label ? trunc(c.theme.label, 72) : "";

      return `
        <button class="campaign-tile" type="button" data-view="campaign" data-view-id="${esc(c.id)}">
          <div class="campaign-tile-head">
            <span class="campaign-tile-name">${esc(c.name)}</span>
            <span class="badge">${c.postIds.length} post${c.postIds.length === 1 ? "" : "s"}</span>
          </div>
          ${themeKind ? `<div class="campaign-tile-theme meta"><span class="badge info">${esc(themeKind)}</span>${themeLabel && themeLabel !== c.name ? ` · ${esc(themeLabel)}` : ""}</div>` : ""}
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

  /* Four, down from six, and Plan leads.
   *
   * Overview was prose about the campaign, Subreddits was the same
   * campaign broken down per community, and Trends was both again as
   * charts — three tabs describing, one tab deciding, and the deciding
   * one was fifth. The two halves of Subreddits went to the tabs that
   * wanted them: "when to post, community by community" is planning and
   * moved to Plan alongside discovery and the cascade, while the
   * per-community charts joined the rest of the charts. Overview's
   * narrative leads Trends, which is where a description belongs. */
  const SECTIONS = ["plan", "posts", "trends", "settings"];

  /* Retired tabs, so a saved section or an old jump link still lands. */
  const MOVED = { overview: "trends", subreddits: "plan", targeting: "plan" };

  /* Communities listed in the Subreddits tab's timing card before it
   * truncates. Its expander used to emit the dashboard's action, which
   * no listener in this view answered, so the button sat there doing
   * nothing while the rest of the list stayed unreachable. */
  let campTimingLimit = 6;

  Workspace.render = function (params) {
    const id = (params && params.id) || AppState.openCampaignId;
    const campaign = id ? Campaigns.get(id) : null;

    if (!campaign) {
      Dom.fill("campaign-status", `<div class="card">${Dom.emptyState({
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
      Dom.fill("campaign-status", `<div class="card">${Dom.skeleton(3, { chart: true })}</div>`);
      return;
    }

    renderSection(activeSection(), campaign, agg);
  };

  function renderHeaderStats(campaign, agg) {
    const metaEl = Dom.byId("campaign-workspace-meta");
    const kpiHost = Dom.byId("campaign-kpis");
    const goalHost = Dom.byId("campaign-goals");
    const alertHost = Dom.byId("campaign-alerts");

    if (metaEl) {
      const created = campaign.createdAt ? Util.relTime(campaign.createdAt / 1000) : "";
      const themeKind = campaign.theme && Campaigns.themeKindLabel
        ? Campaigns.themeKindLabel(campaign.theme)
        : "";
      const themeBit = themeKind
        ? ` · ${themeKind}${campaign.theme.label ? ` “${campaign.theme.label}”` : ""}`
        : "";
      metaEl.textContent = `${campaign.postIds.length} tracked post${campaign.postIds.length === 1 ? "" : "s"}${themeBit}${created ? ` · started ${created}` : ""}`;
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
      ? `<div class="meta err"><strong>Couldn't reach the archive:</strong> ${esc(agg.networkError)}. Try Refresh.</div>`
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

  function activeSection() {
    const s = AppState.campaignSection;
    if (SECTIONS.indexOf(s) !== -1) return s;
    return MOVED[s] || "plan";
  }

  function paintSectionRail() {
    const active = activeSection();
    Dom.paintRail("campaign-section-rail", "campaign-tab", active, "camp-sec-", "#view-campaign .campaign-section");
  }

  function renderSection(section, campaign, agg) {
    paintSectionRail();
    Dom.fill("campaign-status", "");
    if (section === "trends") {
      renderOverview(campaign, agg);
      renderTrends(campaign, agg);
      return renderSubBreakdown(campaign, agg);
    }
    if (section === "plan") return renderPlan(campaign, agg);
    if (section === "posts") return renderPosts(campaign, agg);
    if (section === "settings") return renderSettings(campaign, agg);
  }

  /* Plan's cascade card is static markup wired once by app.js; what
     this fills is timing plus who has not been reached. Inventory
     recommendations and Make-campaign live on the dashboard Plan tab. */
  function renderPlan(campaign, agg) {
    renderCampaignTiming(campaign, agg);
    const discoverFor = Dom.byId("discover-campaign");
    if (discoverFor) discoverFor.value = campaign.id;
  }

  /* ------------------------------------------------------------------
   * OVERVIEW — what the campaign amounts to, in words
   * ------------------------------------------------------------------
   * Deliberately prose and numbers only. The chart gallery that used to
   * sit here pushed this tab past four phone screens, so it moved to
   * Trends and the per-community timing card moved to Subreddits, where
   * the rest of the per-community analysis already lives.
   * ------------------------------------------------------------------ */

  function noPostsCard() {
    return `<div class="card">${Dom.emptyState({
      icon: "◆",
      title: "No posts resolved yet",
      body: "Add the Reddit URLs of the posts in this campaign and they will be fetched and analysed.",
      action: '<button class="btn primary" type="button" data-campaign-goto="posts">Add posts</button>',
    })}</div>`;
  }

  function renderOverview(campaign, agg) {
    const host = Dom.byId("campaign-overview-block");
    if (!host) return;
    const posts = agg.posts || [];

    if (!posts.length) {
      host.innerHTML = noPostsCard();
      return;
    }

    const deep = AppState.campaignDeep;
    const bundle = Analysis.dashboard(posts, { window: "all", label: campaign.name });

    host.innerHTML = `
      ${deep && deep.narrative ? `
        <div class="card">
          <header class="card-header"><div><h2>How this campaign is doing</h2><span class="hint">Read from your campaign's own posts</span></div></header>
          <div class="prose">${deep.narrative}</div>
        </div>` : ""}
      ${deep && deep.comparison ? renderComparison(deep.comparison) : ""}
      ${bundle.profile ? renderProfileCard(bundle) : ""}
      <div class="section-jump">
        <button class="btn small" type="button" data-campaign-goto="trends">See the charts</button>
        <button class="btn small" type="button" data-campaign-goto="plan">Plan the next post</button>
      </div>`;
  }

  /* ------------------------------------------------------------------
   * TRENDS — the campaign's chart gallery
   * ------------------------------------------------------------------ */

  function renderTrends(campaign, agg) {
    const host = Dom.byId("campaign-trends-block");
    if (!host) return;
    const posts = agg.posts || [];

    if (!posts.length) {
      host.innerHTML = noPostsCard();
      return;
    }

    Charts.destroyIn(host);
    const bundle = Analysis.dashboard(posts, { window: "all", themes: false, profile: false });

    host.innerHTML = `
      <div class="grid two">
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
        <div class="card span-2">
          <header class="card-header"><div><h2>Score spread</h2><span class="hint">How evenly the campaign performed</span></div></header>
          <div class="chart-wrap" data-chart="hist"><canvas></canvas></div>
        </div>
      </div>`;

    const mount = (sel, kind, data, opts) => {
      const wrap = host.querySelector(`[data-chart="${sel}"]`);
      if (wrap) Charts.mount(wrap, { kind: kind, data: data, opts: opts });
    };

    mount("timeline", "timeline", Analysis.bucketByTimePerSub(posts, { window: "all" }), { mode: "lines" });
    mount("scatter", "scatter", posts);
    mount("sentiment", "sentiment", bundle.sentiment);
    mount("hist", "histogram", bundle.histogram);
  }

  /* A campaign is usually one or two posts per community, which is
   * never enough to call that community's peak hour from the campaign
   * alone. Where the campaign is too thin, borrow the subreddit's own
   * loaded posts instead — excluding the campaign's, so the answer is
   * "when is this room busy" and not a restatement of when you posted. */
  function campaignTiming(posts) {
    const own = Analysis.postingTimes(posts, { minSample: 3 });
    const rows = own.ranked.slice();

    /* Both the too-thin communities and the ones whose own posts show
     * no time-of-day effect are worth a second look at the sub's
     * ambient traffic — a handful of campaign posts scattered at
     * random will read as "no signal" even where the room has one. */
    for (const thin of own.skipped.concat(own.flat)) {
      const mine = new Set(posts.filter((p) => (p.subreddit || "").toLowerCase() === thin.key).map((p) => p.id));
      const ambient = AppState.postsForSub(thin.subreddit).filter((p) => !mine.has(p.id));
      if (ambient.length < 5) { rows.push(thin); continue; }

      const borrowed = Analysis.postingTimes(ambient, { minSample: 5 }).ranked[0];
      if (!borrowed) { rows.push(thin); continue; }
      borrowed.ambient = true;
      borrowed.campaignCount = thin.count;
      rows.push(borrowed);
    }

    rows.sort((a, b) => b.count - a.count);
    return Analysis.summarizePostingTimes(rows, { minSample: 3 });
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
          <div><div class="stat-label">Communities</div><div class="stat-value">${num((p.subreddits || []).length)}</div></div>
        </div>
        ${kw.length ? `<div class="keyword-cloud" style="margin-top:var(--s-3)">${kw.map((k) => `<span class="kw">${esc(k.word)}<span class="count">${k.count}</span></span>`).join("")}</div>` : ""}
      </div>`;
  }

  /* ------------------------------------------------------------------
   * SUBREDDITS — per-community trend analysis
   * ------------------------------------------------------------------ */

  /* When to post, community by community. Planning, so it sits in Plan,
     directly above the communities this campaign has not reached and the
     cascade that orders them. */
  function renderCampaignTiming(campaign, agg) {
    const posts = agg.posts || [];
    const timingHost = Dom.byId("campaign-posting-times");
    if (!timingHost) return;
    timingHost.innerHTML = !posts.length ? "" : `
      <div class="card">
        <header class="card-header">
          <div><h2>When to post, community by community</h2><span class="hint">Each peak is against that sub's own average — never a figure pooled across them</span></div>
        </header>
        ${UI.postingTimesSummaryHtml(campaignTiming(posts), { limit: campTimingLimit, more: "expand-campaign-timing" })}
      </div>`;
  }

  /* The per-community charts and table. Description rather than
     decision, so these joined the rest of the charts in Trends. */
  function renderSubBreakdown(campaign, agg) {
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
      const cadence = card.querySelector('[data-chart="campaign-cadence"]');
      if (cadence) {
        Charts.mount(cadence, {
          kind: "timeline",
          data: Analysis.bucketByTimePerSub(sub.posts, { window: win }),
          opts: { mode: "total" },
        });
      }
      const hour = card.querySelector('[data-chart="campaign-hour"]');
      if (hour) Charts.mount(hour, { kind: "hourHeat", data: sub.agg });

      const rhythm = card.querySelector('[data-chart="sub-rhythm"]');
      const plan = (sub._charts || []).find((c) => c.kind === "sub-rhythm");
      if (rhythm && plan) Charts.mount(rhythm, { kind: "hourHeat", data: plan.agg });
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
    /* Stashed so the mount pass below can reuse the baseline aggregate
     * this computed rather than deriving it a second time. */
    const charts = (sub._charts = chartPlan(sub));

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

        ${charts.length ? `
          <div class="sub-card-charts${charts.length === 1 ? " single" : ""}">
            ${charts.map((c) => `
              <div class="chart-panel">
                <div class="chart-panel-title">${esc(c.title)}</div>
                <div class="chart-wrap short" data-chart="${esc(c.kind)}"><canvas></canvas></div>
                ${c.caption ? `<div class="chart-panel-caption">${c.caption}</div>` : ""}
              </div>`).join("")}
          </div>` : ""}

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

  /* A cross-post campaign usually puts exactly one post in each sub, and
   * a cadence line through a single point is worse than no chart at all.
   * So the card asks what is actually answerable at this sample size:
   * with a few posts, how the campaign moved over time; with one, how its
   * timing lines up against the rhythm of the sub itself. */
  const MIN_POSTS_TO_CHART = 3;

  function chartPlan(sub) {
    if (sub.count >= MIN_POSTS_TO_CHART) {
      return [
        { kind: "campaign-cadence", title: "Posting cadence" },
        { kind: "campaign-hour", title: "Score by hour" },
      ];
    }

    /* Baseline excludes the campaign's own posts. A single cross-post
     * that outscores the sub's median tenfold would otherwise define the
     * "peak hour" it is being compared against, and the card would
     * cheerfully report that you posted at exactly the right time. */
    const mine = new Set((sub.posts || []).map((p) => p.id));
    const ambient = AppState.postsForSub(sub.subreddit).filter((p) => !mine.has(p.id));
    if (ambient.length < 5) return [];

    const agg = Analysis.aggregate(ambient);
    const posted = (sub.posts || [])
      .map((p) => new Date((p.created_utc || 0) * 1000).getHours())
      .filter((h) => !isNaN(h));

    let peak = -1, peakVal = -Infinity;
    for (let h = 0; h < 24; h++) {
      if (agg.byHour[h] > 0 && agg.avgScoreByHour[h] > peakVal) {
        peakVal = agg.avgScoreByHour[h];
        peak = h;
      }
    }

    let caption = "";
    if (posted.length) {
      const when = posted.map(hh).join(" and ");
      caption = peak >= 0
        ? `You posted at <strong>${when}</strong>; the sub's other ${num(ambient.length)} loaded posts do best around <strong>${hh(peak)}</strong>.`
        : `You posted at <strong>${when}</strong>.`;
    }

    return [{ kind: "sub-rhythm", title: `When r/${sub.subreddit} is busiest`, caption: caption, agg: agg }];
  }

  function hh(hour) {
    return String(hour).padStart(2, "0") + ":00";
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
          <div><h2>Add posts</h2><span class="hint">Paste Reddit post URLs or bare IDs, one per line</span></div>
        </header>
        <div class="add-posts-form" data-campaign-id="${esc(campaign.id)}">
          <textarea data-role="add-posts-textarea" rows="2" placeholder="https://www.reddit.com/r/…/comments/abc123/title/&#10;abc123"></textarea>
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
        <button class="btn tiny cpr-place" type="button" data-action="campaign-place" data-post-id="${esc(p.id)}"
                title="Rank communities for this post, with the hour to post and a cross-post link">Where next</button>
        <button class="cpr-remove" type="button" data-action="remove-post" data-id="${esc(p.id)}" title="Remove from campaign" aria-label="Remove from campaign">×</button>
      </div>`;
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
    Dom.wireRail("campaign-section-rail", "campaign-tab", Workspace.goToSection);
    Dom.delegate(document, "click", "[data-campaign-goto]", (e, btn) => {
      Workspace.goToSection(btn.dataset.campaignGoto);
    });
    Dom.delegate(document, "click", "#campaign-sub-window button", (e, btn) => {
      AppState.campaignSubWindow = btn.dataset.window;
      for (const sib of btn.parentElement.children) sib.classList.toggle("active", sib === btn);
      const campaign = Campaigns.get(AppState.openCampaignId);
      if (campaign && AppState.campaignAgg) renderSubBreakdown(campaign, AppState.campaignAgg);
    });
    Dom.delegate(document, "click", '[data-action="expand-campaign-timing"]', () => {
      campTimingLimit = "all";
      const campaign = Campaigns.get(AppState.openCampaignId);
      if (campaign && AppState.campaignAgg) renderCampaignTiming(campaign, AppState.campaignAgg);
    });
    /* A campaign's posts can live in subreddits nobody loaded, so the
       aggregate is the first place to look — the inventory may never
       have seen this one. FocusView adopts whatever it is handed. */
    Dom.delegate(document, "click", '[data-action="campaign-place"]', (e, btn) => {
      const id = btn.dataset.postId;
      const agg = AppState.campaignAgg;
      const post = ((agg && agg.posts) || []).find((p) => p && p.id === id)
        || AppState.posts.find((p) => p && p.id === id);
      if (post && window.FocusView) FocusView.focusPost(post);
    });

    Dom.delegate(document, "click", '[data-action="add-sub"]', (e, btn) => {
      const added = AppState.addSubs([btn.dataset.sub]);
      App.renderChips();
      App.markPending(null, { scope: "subs" });
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
    section = SECTIONS.indexOf(section) < 0 ? MOVED[section] : section;
    if (!section) return;
    AppState.campaignSection = section;
    const campaign = Campaigns.get(AppState.openCampaignId);
    if (campaign && AppState.campaignAgg) renderSection(section, campaign, AppState.campaignAgg);
    else paintSectionRail();
    Dom.revealRailTab("campaign-section-rail", "campaign-tab", section);
    /* Jumping between sections from a button further down the page
     * should not leave the reader mid-way into the new one. */
    const head = Dom.$("#view-campaign .campaign-workspace-head");
    if (head) window.scrollTo({ top: Math.max(0, head.offsetTop - 8), behavior: "auto" });
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
