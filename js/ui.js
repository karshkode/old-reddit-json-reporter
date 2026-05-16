/* UI rendering helpers. Pure DOM updates; receives data from app.js. */
(function () {
  const UI = {};

  /* ---------- Subreddit chips ---------- */

  UI.renderSubChips = function (subs, active, onToggle, onRemove) {
    const container = document.getElementById("subreddit-chips");
    if (!container) return;
    container.innerHTML = "";
    for (const s of subs) {
      const chip = document.createElement("span");
      chip.className = "chip" + (active.has(s) ? " active" : "");
      chip.dataset.sub = s;
      chip.setAttribute("role", "button");
      chip.tabIndex = 0;
      chip.innerHTML = `r/${Util.escapeHtml(s)}<span class="x" title="remove" aria-label="remove">×</span>`;
      chip.addEventListener("click", (e) => {
        if (e.target.classList.contains("x")) {
          e.stopPropagation();
          onRemove(s);
        } else {
          onToggle(s);
        }
      });
      chip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(s); }
      });
      container.appendChild(chip);
    }
  };

  /* ---------- KPI row ---------- */

  UI.renderKpis = function (agg) {
    const row = document.getElementById("kpi-row");
    if (!row) return;
    const kpis = [
      { label: "Posts", value: Util.fmtNum(agg.count), sub: agg.viewsKnown ? `${agg.viewsKnown} with view counts` : "in window" },
      { label: "Total upvotes", value: Util.fmtNum(agg.totalScore), sub: `avg ${Util.fmtNum(agg.avgScore)} · median ${Util.fmtNum(agg.medianScore)}` },
      { label: "Total comments", value: Util.fmtNum(agg.totalComments), sub: `avg ${Util.fmtNum(agg.avgComments)} per post` },
      { label: "Avg upvote ratio", value: agg.avgUpvoteRatio == null ? "—" : Util.fmtPct(agg.avgUpvoteRatio), sub: "Reddit-reported sentiment" },
      (function () {
        /* "Best posting hour" — replaces the dead Awards KPI (Reddit
         * removed awards in 2023; the field is always 0). Picks the
         * hour with the highest avg score across the loaded posts.
         * `agg.avgScoreByHour` is in local time and `agg.byHour` tells
         * us how many posts seeded each bucket so we can avoid
         * picking a 1-post hour as "best". */
        let best = -1, bestVal = -Infinity;
        const overall = agg.avgScore || 0;
        for (let h = 0; h < 24; h++) {
          if ((agg.byHour && agg.byHour[h] >= 1) && agg.avgScoreByHour[h] > bestVal) {
            bestVal = agg.avgScoreByHour[h];
            best = h;
          }
        }
        if (best < 0) {
          return { label: "Best posting hour", value: "—", sub: "needs more posts" };
        }
        const lift = overall ? Math.round((bestVal - overall) / overall * 100) : 0;
        const tz = (typeof Util.getTzLabel === "function") ? Util.getTzLabel() : "";
        return {
          label: "Best posting hour",
          value: String(best).padStart(2, "0") + ":00" + (tz ? " " + tz : ""),
          sub: lift > 0 ? `+${lift}% above avg score` : `picked from avg score per hour`,
        };
      })(),
      { label: "Top score", value: Util.fmtNum(agg.topPost ? agg.topPost.score : 0), sub: agg.topPost ? `r/${Util.escapeHtml(agg.topPost.subreddit)}` : "" },
    ];
    row.innerHTML = kpis.map((k) => `
      <div class="kpi">
        <div class="label">${Util.escapeHtml(k.label)}</div>
        <div class="value">${k.value}</div>
        <div class="sub">${k.sub}</div>
      </div>
    `).join("");
  };

  /* ---------- Posts table ---------- */

  UI.renderPostsTable = function (posts, sortKey, sortDir, onRowClick) {
    const tbody = document.getElementById("posts-tbody");
    const count = document.getElementById("posts-count");
    if (!tbody) return;
    if (count) count.textContent = posts.length;

    document.querySelectorAll("#posts-table thead th").forEach((th) => {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (th.dataset.sort === sortKey) {
        th.classList.add(sortDir === "asc" ? "sorted-asc" : "sorted-desc");
      }
    });

    if (!posts.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty">No posts match the current filter.</div></td></tr>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const p of posts) {
      const tr = document.createElement("tr");
      tr.dataset.id = p.id;
      tr.tabIndex = 0;
      tr.setAttribute("role", "button");
      tr.innerHTML = `
        <td data-label="When" title="${Util.escapeHtml(Util.fmtDateShort(p.created_utc))} ${Util.escapeHtml(Util.getTzLabel())}">${Util.escapeHtml(Util.relTime(p.created_utc))}</td>
        <td data-label="Sub"><span class="tag">r/${Util.escapeHtml(p.subreddit)}</span></td>
        <td data-label="Title" class="title">
          <span class="title-text" title="${Util.escapeHtml(p.title || "")}">${Util.escapeHtml(p.title || "")}</span>
          ${p.flair ? `<span class="tag flair">${Util.escapeHtml(p.flair)}</span>` : ""}
        </td>
        <td data-label="Author">${Util.escapeHtml(p.author || "")}</td>
        <td data-label="Score" class="num">${Util.fmtNum(p.score)}</td>
        <td data-label="UV %" class="num">${p.upvote_ratio == null ? "—" : Util.fmtPct(p.upvote_ratio)}</td>
        <td data-label="Comments" class="num">${Util.fmtNum(p.num_comments)}</td>
        <td data-label="ID"><code>${Util.escapeHtml(p.id)}</code></td>
      `;
      tr.addEventListener("click", () => onRowClick(p));
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(p); }
      });
      frag.appendChild(tr);
    }
    tbody.innerHTML = "";
    tbody.appendChild(frag);
  };

  /* ---------- Post detail ---------- */

  UI.renderPostDetail = function (post, comments) {
    const card = document.getElementById("post-detail");
    const body = document.getElementById("post-detail-body");
    if (!card || !body) return;
    const wasHidden = !!card.hidden;
    card.hidden = false;
    if (wasHidden) card.scrollIntoView({ behavior: "smooth", block: "start" });

    const sent = Analysis.scoreSentiment(post.title + " " + (post.selftext || ""));
    const sentBadge = sent.score > 0.1
      ? '<span class="badge good">positive</span>'
      : sent.score < -0.1 ? '<span class="badge bad">negative</span>'
      : '<span class="badge info">neutral</span>';

    const commentSent = Analysis.aggregateSentiment(comments.map((c) => ({ title: c.body, selftext: "" })));
    const topComments = comments.slice().sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
    const tq = Analysis.titleQuality(post.title);

    body.innerHTML = `
      <div class="post-detail-grid">
        <div>
          <h3 style="margin:0 0 6px;font-size:15px;line-height:1.35"><a href="${Util.escapeHtml(post.permalink)}" target="_blank" rel="noopener">${Util.escapeHtml(post.title || "")}</a></h3>
          <div class="meta" style="color:var(--text-mute);font-size:12px;margin-bottom:10px">
            r/${Util.escapeHtml(post.subreddit)} · u/${Util.escapeHtml(post.author || "")} · ${Util.escapeHtml(Util.relTime(post.created_utc))}
            ${post.flair ? ` · <span class="tag flair">${Util.escapeHtml(post.flair)}</span>` : ""}
            · ${sentBadge}
          </div>

          ${renderTitleQualityBlock(tq)}

          ${post.selftext ? `<div style="white-space:pre-wrap;font-size:13px;color:var(--text-dim);max-height:240px;overflow:auto;background:var(--bg-elev-2);padding:10px;border-radius:8px;word-break:break-word;margin-top:10px">${Util.escapeHtml(post.selftext.slice(0, 4000))}</div>` : ""}

          <h4 style="margin:14px 0 6px;font-size:13px">Top comments (${comments.length})</h4>
          <div class="comment-list">
            ${comments.length ? topComments.map((c) => `
              <div class="comment">
                <div class="meta">u/${Util.escapeHtml(c.author || "")} · ${Util.fmtNum(c.score)} pts · ${c.replies} replies · ${Util.escapeHtml(Util.relTime(c.created_utc))}</div>
                <div class="body">${Util.escapeHtml((c.body || "").slice(0, 480))}${(c.body || "").length > 480 ? "…" : ""}</div>
              </div>
            `).join("") : '<div class="empty">No comments returned.</div>'}
          </div>
        </div>
        <div>
          <dl class="kv">
            <dt>ID</dt><dd><code>${Util.escapeHtml(post.id)}</code></dd>
            <dt>Score</dt><dd>${Util.fmtNum(post.score)} (${post.ups != null ? Util.fmtNum(post.ups) + " ups" : "—"})</dd>
            <dt>UV ratio</dt><dd>${post.upvote_ratio == null ? "—" : Util.fmtPct(post.upvote_ratio)}</dd>
            <dt>Comments</dt><dd>${Util.fmtNum(post.num_comments)}</dd>
            <dt>Views</dt><dd>${post.view_count == null ? "<em>hidden</em>" : Util.fmtNum(post.view_count)}</dd>
            <dt>Domain</dt><dd>${Util.escapeHtml(post.domain || "")}</dd>
            <dt>URL</dt><dd><a href="${Util.escapeHtml(post.url || "")}" target="_blank" rel="noopener">${Util.escapeHtml((post.url || "").slice(0, 80))}</a></dd>
            <dt>Permalink</dt><dd><a href="${Util.escapeHtml(post.permalink)}" target="_blank" rel="noopener">open thread</a></dd>
            <dt>Posted</dt><dd>${Util.escapeHtml(Util.fmtDateShort(post.created_utc))} ${Util.escapeHtml(Util.getTzLabel())}</dd>
            <dt>Comments<br>sentiment</dt><dd>${commentSent.positive} pos / ${commentSent.negative} neg / ${commentSent.neutral} neu</dd>
          </dl>
        </div>
      </div>
    `;
  };

  function renderTitleQualityBlock(tq) {
    const band = tq.band || "okay";
    const cls = band === "excellent" ? "good" : band === "good" ? "info" : band === "okay" ? "warn" : "bad";
    const factors = tq.factors.map((f) =>
      `<li class="qf ${f.ok ? "ok" : "bad"}"><span>${Util.escapeHtml(f.label)}</span><span class="delta">${f.delta > 0 ? "+" : ""}${f.delta}</span></li>`
    ).join("");
    return `
      <div class="quality-block">
        <div class="quality-head">
          <div>
            <strong>Title quality</strong>
            <span class="badge ${cls}">${tq.score} · ${band}</span>
          </div>
          <div class="meta">${tq.length} chars · ${tq.words} words</div>
        </div>
        <div class="quality-bar"><span style="width:${tq.score}%"></span></div>
        <ul class="quality-factors">${factors}</ul>
      </div>
    `;
  }

  UI.hidePostDetail = function () {
    const card = document.getElementById("post-detail");
    if (card) card.hidden = true;
  };

  /* ---------- Keywords / cross-posts / recommendations ---------- */

  UI.renderKeywords = function (words) {
    const el = document.getElementById("keywords");
    if (!el) return;
    if (!words.length) { el.innerHTML = '<div class="empty">Not enough text to extract keywords.</div>'; return; }
    el.innerHTML = words.map((w) => `<span class="kw">${Util.escapeHtml(w.word)}<span class="count">${w.count}</span></span>`).join("");
  };

  UI.renderCrossPosts = function (groups) {
    const el = document.getElementById("crossposts");
    if (!el) return;
    if (!groups.length) { el.innerHTML = '<div class="empty">No cross-posts detected in the loaded set.</div>'; return; }
    el.innerHTML = groups.slice(0, 20).map((g, i) => {
      const headline = g.kind === "url" ? truncate(g.key, 90) : truncate(g.posts[0].title, 110);
      /* Spread-tier badge: 2 subs = info, 3-4 subs = warn, 5+ subs = good. */
      const spread = g.subs.length;
      const tier = spread >= 5 ? "good" : spread >= 3 ? "warn" : "info";
      return `
        <div class="crosspost-row" data-spread="${spread}">
          <div class="crosspost-head">
            <strong>${Util.escapeHtml(headline)}</strong>
            <span class="badge ${tier}" title="Cross-posted across ${spread} subreddits">in ${spread} sub${spread === 1 ? "" : "s"}</span>
          </div>
          <div class="subs">${g.subs.map((s) => `r/${Util.escapeHtml(s)}`).join(" · ")} · ${Util.fmtNum(g.totalScore)} pts · ${Util.fmtNum(g.totalComments)} comments</div>
          <div class="crosspost-actions">
            <button class="btn small primary"
                    type="button"
                    data-action="make-campaign-from-crosspost"
                    data-cp-index="${i}"
                    aria-label="Convert this cross-post group into a new campaign">+ Make campaign</button>
          </div>
        </div>
      `;
    }).join("");
  };

  UI.renderRecommendations = function (lines) {
    const el = document.getElementById("recommendations");
    if (!el) return;
    el.innerHTML = lines.map((l) => `<li>${l}</li>`).join("");
  };

  UI.renderNarrative = function (html) {
    const el = document.getElementById("ai-summary");
    if (el) el.innerHTML = html;
  };

  /* ---------- Themes ---------- */

  UI.renderThemes = function (themes) {
    const el = document.getElementById("themes");
    if (!el) return;
    if (!themes || !themes.length) {
      el.innerHTML = '<div class="empty">Not enough variety to identify themes.</div>';
      return;
    }
    el.innerHTML = themes.slice(0, 14).map((t) => {
      const sentClass = t.sentiment.average > 0.1 ? "good" : t.sentiment.average < -0.1 ? "bad" : "info";
      const sentLabel = t.sentiment.average > 0.1 ? "positive" : t.sentiment.average < -0.1 ? "negative" : "neutral";
      const examples = t.examples.slice(0, 2).map((p) =>
        `<a href="${Util.escapeHtml(p.permalink)}" target="_blank" rel="noopener" title="${Util.escapeHtml(p.title || "")}">${Util.escapeHtml(truncate(p.title || "", 60))}</a>`
      ).join(" · ");
      return `
        <div class="theme-row">
          <div class="theme-head">
            <span class="theme-term">${t.kind === "phrase" ? `"${Util.escapeHtml(t.term)}"` : Util.escapeHtml(t.term)}</span>
            <span class="badge ${sentClass}">${sentLabel}</span>
            <span class="meta">${t.count} posts · ${Util.fmtNum(t.totalScore)} pts · ${Util.fmtNum(t.totalComments)} comments · ${t.subSpread} sub${t.subSpread > 1 ? "s" : ""}</span>
          </div>
          <div class="theme-meta">avg ${Util.fmtNum(t.avgScore)} score · top in r/${Util.escapeHtml(t.topSub || "—")} · ${examples}</div>
        </div>
      `;
    }).join("");
  };

  /* ---------- Subreddit profiles ---------- */

  UI.renderSubProfiles = function (profiles) {
    const el = document.getElementById("sub-profiles");
    if (!el) return;
    const list = Object.values(profiles || {});
    if (!list.length) { el.innerHTML = '<div class="empty">Load at least one subreddit to see profiles.</div>'; return; }
    list.sort((a, b) => b.totalScore - a.totalScore);
    el.innerHTML = list.map((p) => {
      const sentClass = p.sentiment.average > 0.1 ? "good" : p.sentiment.average < -0.1 ? "bad" : "info";
      const sentLabel = p.sentiment.average > 0.1 ? "positive" : p.sentiment.average < -0.1 ? "negative" : "neutral";
      const recCls = p.reception === "warm" ? "good" : p.reception === "healthy" ? "info" : p.reception === "mixed" ? "warn" : p.reception === "contentious" ? "bad" : "info";
      const themes = (p.themes || []).slice(0, 5).map((t) => `<span class="kw">${t.kind === "phrase" ? `"${Util.escapeHtml(t.term)}"` : Util.escapeHtml(t.term)}<span class="count">${t.count}</span></span>`).join("");
      const keys = (p.keywords || []).slice(0, 8).map((k) => `<span class="tag">${Util.escapeHtml(k.word)}</span>`).join(" ");
      return `
        <div class="profile-card">
          <div class="profile-head">
            <h3>r/${Util.escapeHtml(p.subreddit || p.label)}</h3>
            <div class="profile-badges">
              <span class="badge ${sentClass}">${sentLabel}</span>
              <span class="badge ${recCls}">${p.reception}</span>
              <span class="badge info">${p.style}</span>
            </div>
          </div>
          <div class="profile-stats">
            <div><span class="label">Posts</span><strong>${Util.fmtNum(p.count)}</strong></div>
            <div><span class="label">Median score</span><strong>${Util.fmtNum(p.medianScore)}</strong></div>
            <div><span class="label">Avg comments</span><strong>${Util.fmtNum(p.avgComments)}</strong></div>
            <div><span class="label">UV ratio</span><strong>${p.avgUpvoteRatio == null ? "—" : Util.fmtPct(p.avgUpvoteRatio)}</strong></div>
            <div><span class="label">Best hour</span><strong>${p.bestHour >= 0 ? String(p.bestHour).padStart(2, "0") + ":00" : "—"}</strong></div>
            <div><span class="label">Best day</span><strong>${Analysis.DAY_NAMES[p.bestDow].slice(0, 3)}</strong></div>
          </div>
          ${themes ? `<div class="profile-line"><span class="profile-label">Themes</span><div class="keyword-cloud">${themes}</div></div>` : ""}
          ${keys ? `<div class="profile-line"><span class="profile-label">Top words</span><div>${keys}</div></div>` : ""}
        </div>
      `;
    }).join("");
  };

  /* ---------- Targeting recommendations ---------- */

  UI.renderTargeting = function (campaign, targets, container, opts) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) return;
    opts = opts || {};
    if (!campaign) {
      el.innerHTML = '<div class="empty">Pick a campaign to see targeting recommendations.</div>';
      return;
    }
    if (!targets || !targets.length) {
      el.innerHTML = `<div class="empty">Load more subreddits in the dashboard to compute targeting fits for "${Util.escapeHtml(campaign.name)}". Targeting compares the campaign's themes/sentiment against each loaded sub.</div>`;
      return;
    }
    const head = opts.heading
      ? `<div class="meta" style="margin-bottom:8px">Best loaded subreddits for <strong>${Util.escapeHtml(campaign.name)}</strong>, ranked by theme overlap, sentiment alignment, audience reception, and activity.</div>`
      : "";
    el.innerHTML = head + targets.map((t, i) => {
      const cls = t.score >= 70 ? "good" : t.score >= 50 ? "info" : t.score >= 30 ? "warn" : "bad";
      const reasonsHtml = t.reasons.map((r) => `<li>${r}</li>`).join("");
      const segments = `
        <div class="meter">
          ${meterRow("Themes", t.themeJaccard, "var(--accent)")}
          ${meterRow("Sentiment", t.sentMatch, "var(--info)")}
          ${meterRow("Reception", t.reception, "var(--good)")}
          ${meterRow("Activity", t.activity, "var(--warn)")}
        </div>
      `;
      return `
        <div class="target-row${t.alreadyTargeted ? " already" : ""}">
          <div class="target-head">
            <div>
              <span class="rank">#${i + 1}</span>
              <strong>r/${Util.escapeHtml(t.subreddit)}</strong>
              <span class="badge ${cls}">fit ${t.score}</span>
            </div>
            <div class="target-meta">${Util.fmtNum(t.profile.count)} posts · ${Util.fmtNum(t.profile.totalScore)} pts</div>
          </div>
          ${segments}
          <ul class="target-reasons">${reasonsHtml}</ul>
        </div>
      `;
    }).join("");
  };

  /* Render new-subreddit candidates discovered via Reddit search.
   *
   * `result` shape:
   *   { candidates:[...], alreadyLoaded:[...], totalScanned: N }
   * (for back-compat we still accept a plain array). */
  UI.renderDiscoveryCandidates = function (result, container, ctx) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) return;
    ctx = ctx || {};
    let candidates, alreadyLoaded, totalScanned;
    if (Array.isArray(result)) {
      candidates = result; alreadyLoaded = []; totalScanned = result.length;
    } else if (result) {
      candidates = result.candidates || [];
      alreadyLoaded = result.alreadyLoaded || [];
      totalScanned = result.totalScanned || (candidates.length + alreadyLoaded.length);
    } else {
      candidates = []; alreadyLoaded = []; totalScanned = 0;
    }

    if (!candidates.length && !alreadyLoaded.length) {
      el.innerHTML = '<div class="empty">No candidate subreddits found. Try opening a campaign with richer post content first.</div>';
      return;
    }

    /* Cross-post submit support: if the discovery context carries a
     * representative campaign post (`ctx.bestCampaignPost`) and the
     * candidate sub isn't already hosting that campaign, we render a
     * "Cross-post here" link that opens Reddit's compose page with the
     * post's title + selftext (markdown) or URL pre-filled.
     *
     * `ctx.campaignSubs` is a Set of subreddit names (lowercase) the
     * campaign already lives in — those subs DON'T get the submit link
     * (the user has already posted there). */
    const bestPost = ctx.bestCampaignPost || null;
    const campaignName = ctx.campaign && ctx.campaign.name;
    const campaignSubs = ctx.campaignSubs instanceof Set ? ctx.campaignSubs : new Set();

    function renderCard(c, i, isAlready) {
      const cls = c.score >= 70 ? "good" : c.score >= 50 ? "info" : c.score >= 30 ? "warn" : "bad";
      const reasons = c.reasons.map((r) => `<li>${r}</li>`).join("");
      const desc = c.candidate.public_description ? `<div class="cand-desc">${Util.escapeHtml(c.candidate.public_description.slice(0, 220))}${c.candidate.public_description.length > 220 ? "…" : ""}</div>` : "";
      const meters = `
        <div class="meter">
          ${meterRow("Theme", c.themeMatch, "var(--accent)")}
          ${meterRow("Popularity", c.popularity, "var(--info)")}
          ${meterRow("Activity", c.engagement, "var(--good)")}
        </div>
      `;
      const action = isAlready
        ? `<span class="badge info">already in your dashboard</span>`
        : `<button class="btn small primary" data-action="add" data-name="${Util.escapeHtml(c.canonical)}">＋ Add to dashboard</button>`;

      /* Submit-to-Reddit link (only when we have a campaign post template
       * AND the candidate sub doesn't already host it). */
      let submitLink = "";
      if (bestPost && !campaignSubs.has(c.canonical)) {
        const submitUrl = Util.buildSubmitUrl(c.canonical, bestPost);
        if (submitUrl) {
          const titleHint = String(bestPost.title || "").slice(0, 120);
          const tip = `Open Reddit's compose page in r/${c.canonical} pre-filled with "${titleHint}"${campaignName ? ` from "${campaignName}"` : ""}`;
          submitLink = `<a class="btn small submit-link" href="${Util.escapeHtml(submitUrl)}" target="_blank" rel="noopener" title="${Util.escapeHtml(tip)}">↪ Cross-post here</a>`;
        }
      }

      return `
        <div class="target-row candidate ${isAlready ? "already" : ""}" data-name="${Util.escapeHtml(c.canonical)}">
          <div class="target-head">
            <div>
              <span class="rank">#${i + 1}</span>
              <strong>r/${Util.escapeHtml(c.name)}</strong>
              <span class="badge ${cls}">fit ${c.score}</span>
            </div>
            <div class="target-meta">${Util.fmtNum(c.candidate.subscribers)} subs${c.candidate.active_user_count ? ` · ${Util.fmtNum(c.candidate.active_user_count)} online` : ""}</div>
          </div>
          ${desc}
          ${meters}
          <ul class="target-reasons">${reasons}</ul>
          <div class="cand-actions">
            ${action}
            ${submitLink}
            <a class="btn small ghost" href="https://www.reddit.com/r/${Util.escapeHtml(c.canonical)}/" target="_blank" rel="noopener">Open in reddit ↗</a>
          </div>
        </div>
      `;
    }

    const newSection = candidates.length
      ? `<div class="discover-section">
           <h4 class="discover-h">New candidates (${candidates.length})</h4>
           ${candidates.map((c, i) => renderCard(c, i, false)).join("")}
         </div>`
      : `<div class="discover-section"><h4 class="discover-h">New candidates (0)</h4>
           <div class="empty">Every match is already in your dashboard. Scroll down to see how your existing subs scored, or load fewer subs and re-run Discover for fresh ideas.</div>
         </div>`;

    const alreadySection = alreadyLoaded.length
      ? `<div class="discover-section">
           <h4 class="discover-h">Already in your dashboard (${alreadyLoaded.length})</h4>
           <div class="discover-sub-hint">Confirms the engine ranked these high too — proof the discovery query is on-target.</div>
           ${alreadyLoaded.map((c, i) => renderCard(c, i, true)).join("")}
         </div>`
      : "";

    el.innerHTML = newSection + alreadySection;
  };

  function meterRow(label, value, color) {
    const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
    return `<div class="meter-row"><span class="meter-label">${Util.escapeHtml(label)}</span><div class="meter-bar"><span style="width:${pct}%;background:${color}"></span></div><span class="meter-val">${pct}</span></div>`;
  }

  /* ---------- Campaign list ---------- */

  UI.renderCampaignList = function (campaigns, summaries, onOpen) {
    const el = document.getElementById("campaign-list");
    if (!el) return;
    if (!campaigns.length) { el.innerHTML = '<div class="empty">No campaigns yet. Add one to track a list of cross-posts toward a goal.</div>'; return; }
    el.innerHTML = "";
    for (const c of campaigns) {
      const summary = summaries[c.id] || {};
      const totalScore = summary.totalScore || 0;
      const totalComments = summary.totalComments || 0;
      const progress = c.goalScore ? Math.min(1, totalScore / c.goalScore) : 0;
      const card = document.createElement("div");
      card.className = "campaign-card";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.innerHTML = `
        <div style="min-width:0;flex:1">
          <div><strong>${Util.escapeHtml(c.name)}</strong></div>
          <div class="meta">${c.postIds.length} IDs · ${Util.fmtNum(totalScore)} pts · ${Util.fmtNum(totalComments)} comments${c.goalScore ? ` · goal ${Util.fmtNum(c.goalScore)}` : ""}</div>
        </div>
        <div class="progress">
          <div class="progress-bar"><span style="width:${(progress * 100).toFixed(1)}%"></span></div>
          <div class="meta" style="text-align:right;margin-top:2px">${c.goalScore ? Math.round(progress * 100) + "%" : "—"}</div>
        </div>
      `;
      card.addEventListener("click", () => onOpen(c));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(c); }
      });
      el.appendChild(card);
    }
  };

  /* ---------- Campaign detail (extended with deep analysis) ---------- */

  UI.renderCampaignDetail = function (campaign, agg, deep) {
    const card = document.getElementById("campaign-detail");
    const title = document.getElementById("campaign-detail-title");
    const body = document.getElementById("campaign-detail-body");
    if (!card) return;
    /* Only scroll the detail card into view on the FIRST render after it
     * was hidden — i.e. when the user is genuinely opening a campaign.
     * Re-renders triggered by add/remove post or background refreshes
     * should leave the user's current scroll position alone. */
    const wasHidden = !!card.hidden;
    card.hidden = false;
    if (title) title.textContent = campaign.name;
    if (wasHidden) card.scrollIntoView({ behavior: "smooth", block: "start" });

    const goalScorePct = campaign.goalScore ? Math.min(1, agg.totalScore / campaign.goalScore) : null;
    const goalCommentsPct = campaign.goalComments ? Math.min(1, agg.totalComments / campaign.goalComments) : null;
    const subList = agg.subs.map((s) => `r/${Util.escapeHtml(s)}`).join(", ") || "—";

    const postsList = agg.posts.length ? `
      <div class="campaign-posts" style="margin-top:12px;display:flex;flex-direction:column;gap:6px">
        ${agg.posts.map((p) => `
          <div class="campaign-post-row">
            <a href="${Util.escapeHtml(p.permalink)}" target="_blank" rel="noopener" class="campaign-post-link">
              <div class="cpr-title">${Util.escapeHtml((p.title || "").slice(0, 140))}</div>
              <div class="cpr-meta">r/${Util.escapeHtml(p.subreddit)} · <code>${Util.escapeHtml(p.id)}</code> · ${Util.escapeHtml(Util.relTime(p.created_utc))}</div>
            </a>
            <div class="cpr-stats">
              <strong class="cpr-score">▲ ${Util.fmtNum(p.score)}</strong>
              <span>💬 ${Util.fmtNum(p.num_comments)}</span>
              ${p.upvote_ratio != null ? `<span>${Util.fmtPct(p.upvote_ratio)}</span>` : ""}
            </div>
            <button class="cpr-remove" type="button" data-action="remove-post" data-id="${Util.escapeHtml(p.id)}" title="Remove from campaign" aria-label="Remove from campaign">×</button>
          </div>
        `).join("")}
      </div>
    ` : '<div class="empty" style="margin-top:12px">No posts found yet — fetch failed or IDs are invalid.</div>';

    const missingNote = agg.missing && agg.missing.length
      ? `<div class="meta" style="color:var(--warn);margin-top:6px;font-size:12px">Could not resolve: ${agg.missing.map((id) => `<code>${Util.escapeHtml(id)}</code>`).join(", ")}</div>`
      : "";

    const deepHtml = deep ? renderCampaignDeepAnalysis(deep) : "";

    body.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="label">Posts tracked</div><div class="value">${campaign.postIds.length}</div><div class="sub">${agg.posts.length} resolved</div></div>
        <div class="kpi"><div class="label">Total upvotes</div><div class="value">${Util.fmtNum(agg.totalScore)}</div><div class="sub">${campaign.goalScore ? "goal " + Util.fmtNum(campaign.goalScore) : "no goal set"}</div></div>
        <div class="kpi"><div class="label">Total comments</div><div class="value">${Util.fmtNum(agg.totalComments)}</div><div class="sub">${campaign.goalComments ? "goal " + Util.fmtNum(campaign.goalComments) : "no goal set"}</div></div>
        <div class="kpi"><div class="label">Subreddits</div><div class="value">${agg.subs.length}</div><div class="sub" title="${Util.escapeHtml(subList)}">${Util.escapeHtml(subList)}</div></div>
        <div class="kpi"><div class="label">Views</div><div class="value">${agg.totalViews ? Util.fmtNum(agg.totalViews) : "—"}</div><div class="sub">${agg.totalViews ? "where reported" : "Reddit hides this"}</div></div>
      </div>
      ${goalScorePct != null ? `<div style="margin-top:10px"><div class="meta" style="font-size:11px;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:4px">Score progress (${Math.round(goalScorePct * 100)}%)</div><div class="progress-bar"><span style="width:${(goalScorePct * 100).toFixed(1)}%"></span></div></div>` : ""}
      ${goalCommentsPct != null ? `<div style="margin-top:8px"><div class="meta" style="font-size:11px;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:4px">Comment progress (${Math.round(goalCommentsPct * 100)}%)</div><div class="progress-bar"><span style="width:${(goalCommentsPct * 100).toFixed(1)}%"></span></div></div>` : ""}
      ${missingNote}

      <div class="add-posts-form" data-campaign-id="${Util.escapeHtml(campaign.id)}">
        <div class="add-posts-head">
          <strong>Add more posts</strong>
          <span class="hint">paste reddit URLs, share links, or bare IDs — extracts on Add</span>
        </div>
        <textarea data-role="add-posts-textarea" rows="2" placeholder="https://www.reddit.com/r/X/comments/abc1234/title/&#10;https://www.reddit.com/r/Y/s/AbCdEf1234"></textarea>
        <div class="add-posts-row">
          <div class="paste-preview" data-role="add-posts-preview" hidden></div>
          <button class="btn small primary" type="button" data-action="add-posts">Add posts</button>
        </div>
      </div>

      ${deepHtml}
      ${postsList}
    `;
  };

  function renderCampaignDeepAnalysis(deep) {
    if (!deep) return "";
    const { profile, perSub, comparison, targets, narrative } = deep;
    if (!profile || profile.count === 0) return "";

    const sentClass = profile.sentiment.average > 0.1 ? "good" : profile.sentiment.average < -0.1 ? "bad" : "info";
    const sentLabel = profile.sentiment.average > 0.1 ? "positive" : profile.sentiment.average < -0.1 ? "negative" : "neutral";

    const themesHtml = (profile.themes || []).slice(0, 8).map((t) => `<span class="kw">${t.kind === "phrase" ? `"${Util.escapeHtml(t.term)}"` : Util.escapeHtml(t.term)}<span class="count">${t.count}</span></span>`).join("");

    const perSubRows = perSub && perSub.length ? `
      <div class="table-wrap mini">
      <table class="mini-table">
        <thead><tr><th>Subreddit</th><th class="num">Posts</th><th class="num">Score</th><th class="num">Comments</th><th class="num">Avg score</th><th class="num">UV %</th></tr></thead>
        <tbody>
          ${perSub.map((r) => `
            <tr>
              <td>r/${Util.escapeHtml(r.subreddit)}</td>
              <td class="num">${Util.fmtNum(r.count)}</td>
              <td class="num">${Util.fmtNum(r.totalScore)}</td>
              <td class="num">${Util.fmtNum(r.totalComments)}</td>
              <td class="num">${Util.fmtNum(r.avgScore)}</td>
              <td class="num">${r.avgUpvoteRatio == null ? "—" : Util.fmtPct(r.avgUpvoteRatio)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      </div>
    ` : "";

    const compHtml = comparison ? `
      <div class="deep-compare">
        <ul class="reco-list">${comparison.insights.map((i) => `<li>${i}</li>`).join("")}</ul>
        <div class="compare-grid">
          ${miniStat("Top avg score", Util.fmtNum(comparison.top.avgScore), Util.fmtNum(comparison.bottom.avgScore))}
          ${miniStat("Title length", Math.round(comparison.top.avgLen) + " ch", Math.round(comparison.bottom.avgLen) + " ch")}
          ${miniStat("Sentiment", comparison.top.avgSent.toFixed(2), comparison.bottom.avgSent.toFixed(2))}
          ${miniStat("Hour (" + Util.getTzLabel() + ")", comparison.top.avgHour == null ? "—" : pad2(Math.round(comparison.top.avgHour)) + ":00", comparison.bottom.avgHour == null ? "—" : pad2(Math.round(comparison.bottom.avgHour)) + ":00")}
        </div>
      </div>
    ` : "";

    return `
      <div class="deep-section">
        <h3 class="deep-h">Deep analysis</h3>
        ${narrative ? `<div class="prose">${narrative}</div>` : ""}

        <div class="deep-grid">
          <div class="deep-card">
            <h4>Profile</h4>
            <div class="profile-badges">
              <span class="badge ${sentClass}">${sentLabel}</span>
              <span class="badge info">${profile.style}</span>
              <span class="badge ${profile.reception === "warm" ? "good" : profile.reception === "healthy" ? "info" : profile.reception === "mixed" ? "warn" : profile.reception === "contentious" ? "bad" : "info"}">${profile.reception}</span>
            </div>
            <div class="profile-stats">
              <div><span class="label">Avg score</span><strong>${Util.fmtNum(profile.avgScore)}</strong></div>
              <div><span class="label">Median score</span><strong>${Util.fmtNum(profile.medianScore)}</strong></div>
              <div><span class="label">Avg comments</span><strong>${Util.fmtNum(profile.avgComments)}</strong></div>
              <div><span class="label">UV ratio</span><strong>${profile.avgUpvoteRatio == null ? "—" : Util.fmtPct(profile.avgUpvoteRatio)}</strong></div>
              <div><span class="label">Best hour</span><strong>${profile.bestHour >= 0 ? String(profile.bestHour).padStart(2, "0") + ":00" : "—"}</strong></div>
              <div><span class="label">Best day</span><strong>${Analysis.DAY_NAMES[profile.bestDow].slice(0, 3)}</strong></div>
            </div>
            ${themesHtml ? `<div class="profile-line"><span class="profile-label">Themes</span><div class="keyword-cloud">${themesHtml}</div></div>` : ""}
          </div>

          <div class="deep-card">
            <h4>Performance by subreddit</h4>
            ${perSubRows || '<div class="empty">Single-subreddit campaign — add cross-posts in other subs to compare.</div>'}
          </div>

          <div class="deep-card span-2">
            <h4>What separates winners from losers</h4>
            ${compHtml || '<div class="empty">Need at least 4 posts to compute top-vs-bottom comparison.</div>'}
          </div>

          <div class="deep-card span-2">
            <h4>Where to target next</h4>
            <div id="campaign-detail-targets"></div>
          </div>
        </div>
      </div>
    `;
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function miniStat(label, top, bottom) {
    return `<div class="mini-stat">
      <span class="meta">${Util.escapeHtml(label)}</span>
      <span><strong style="color:var(--good)">${Util.escapeHtml(String(top))}</strong> <span class="meta">vs</span> <strong style="color:var(--bad)">${Util.escapeHtml(String(bottom))}</strong></span>
    </div>`;
  }

  UI.hideCampaignDetail = function () {
    const card = document.getElementById("campaign-detail");
    if (card) card.hidden = true;
  };

  /* ---------- Tabs ---------- */

  /* Scroll the active tab into view *horizontally* within its strip,
   * never touching window vertical scroll. The previous implementation
   * called tab.scrollIntoView({ block: "nearest", behavior: "smooth" })
   * which on iOS Safari can yank the entire page scroll because the
   * tabs strip is position:sticky — a known Safari quirk. */
  function scrollTabHorizontalIntoView(tab) {
    const strip = tab && tab.parentElement;
    if (!strip) return;
    const tr = tab.getBoundingClientRect();
    const sr = strip.getBoundingClientRect();
    if (tr.left < sr.left) {
      strip.scrollLeft += tr.left - sr.left - 8;
    } else if (tr.right > sr.right) {
      strip.scrollLeft += tr.right - sr.right + 8;
    }
  }

  UI.activateTab = function (name) {
    let activeTab = null;
    document.querySelectorAll(".tab").forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
      if (active) activeTab = t;
    });
    if (activeTab) scrollTabHorizontalIntoView(activeTab);
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  };

  function truncate(s, n) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  window.UI = UI;
})();
