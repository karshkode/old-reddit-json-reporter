/* UI rendering helpers. Pure DOM updates; receives data from app.js. */
(function () {
  const UI = {};

  UI.renderSubChips = function (subs, active, onToggle, onRemove) {
    const container = document.getElementById("subreddit-chips");
    if (!container) return;
    container.innerHTML = "";
    for (const s of subs) {
      const chip = document.createElement("span");
      chip.className = "chip" + (active.has(s) ? " active" : "");
      chip.dataset.sub = s;
      chip.innerHTML = `r/${Util.escapeHtml(s)}<span class="x" title="remove">×</span>`;
      chip.addEventListener("click", (e) => {
        if (e.target.classList.contains("x")) {
          e.stopPropagation();
          onRemove(s);
        } else {
          onToggle(s);
        }
      });
      container.appendChild(chip);
    }
  };

  UI.renderKpis = function (agg) {
    const row = document.getElementById("kpi-row");
    if (!row) return;
    const kpis = [
      { label: "Posts", value: Util.fmtNum(agg.count), sub: agg.viewsKnown ? `${agg.viewsKnown} with view counts` : "in window" },
      { label: "Total upvotes", value: Util.fmtNum(agg.totalScore), sub: `avg ${Util.fmtNum(agg.avgScore)} · median ${Util.fmtNum(agg.medianScore)}` },
      { label: "Total comments", value: Util.fmtNum(agg.totalComments), sub: `avg ${Util.fmtNum(agg.avgComments)} per post` },
      { label: "Avg upvote ratio", value: agg.avgUpvoteRatio == null ? "—" : Util.fmtPct(agg.avgUpvoteRatio), sub: "Reddit-reported community sentiment" },
      { label: "Total awards", value: Util.fmtNum(agg.totalAwards), sub: "across loaded posts" },
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

  UI.renderPostsTable = function (posts, sortKey, sortDir, onRowClick) {
    const tbody = document.getElementById("posts-tbody");
    const count = document.getElementById("posts-count");
    if (!tbody) return;
    count.textContent = posts.length;

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
      tr.innerHTML = `
        <td title="${Util.escapeHtml(Util.fmtDateShort(p.created_utc))} UTC">${Util.escapeHtml(Util.relTime(p.created_utc))}</td>
        <td><span class="tag">r/${Util.escapeHtml(p.subreddit)}</span></td>
        <td class="title"><span class="title-text" title="${Util.escapeHtml(p.title || "")}">${Util.escapeHtml(p.title || "")}</span>
          ${p.flair ? `<br><span class="tag flair">${Util.escapeHtml(p.flair)}</span>` : ""}
        </td>
        <td>${Util.escapeHtml(p.author || "")}</td>
        <td class="num">${Util.fmtNum(p.score)}</td>
        <td class="num">${p.upvote_ratio == null ? "—" : Util.fmtPct(p.upvote_ratio)}</td>
        <td class="num">${Util.fmtNum(p.num_comments)}</td>
        <td><code>${Util.escapeHtml(p.id)}</code></td>
      `;
      tr.addEventListener("click", () => onRowClick(p));
      frag.appendChild(tr);
    }
    tbody.innerHTML = "";
    tbody.appendChild(frag);
  };

  UI.renderPostDetail = function (post, comments) {
    const card = document.getElementById("post-detail");
    const body = document.getElementById("post-detail-body");
    if (!card || !body) return;
    card.hidden = false;
    card.scrollIntoView({ behavior: "smooth", block: "start" });

    const sent = Analysis.scoreSentiment(post.title + " " + (post.selftext || ""));
    const sentBadge = sent.score > 0.1
      ? '<span class="badge good">positive</span>'
      : sent.score < -0.1 ? '<span class="badge bad">negative</span>'
      : '<span class="badge info">neutral</span>';

    const commentSent = Analysis.aggregateSentiment(comments.map((c) => ({ title: c.body, selftext: "" })));
    const topComments = comments.slice().sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);

    body.innerHTML = `
      <div class="post-detail-grid">
        <div>
          <h3 style="margin:0 0 6px"><a href="${Util.escapeHtml(post.permalink)}" target="_blank" rel="noopener">${Util.escapeHtml(post.title || "")}</a></h3>
          <div class="meta" style="color:var(--text-mute);font-size:12px;margin-bottom:10px">
            r/${Util.escapeHtml(post.subreddit)} · u/${Util.escapeHtml(post.author || "")} · ${Util.escapeHtml(Util.relTime(post.created_utc))}
            ${post.flair ? ` · <span class="tag flair">${Util.escapeHtml(post.flair)}</span>` : ""}
            · ${sentBadge}
          </div>
          ${post.selftext ? `<div style="white-space:pre-wrap;font-size:13px;color:var(--text-dim);max-height:240px;overflow:auto;background:var(--bg-elev-2);padding:10px;border-radius:8px;">${Util.escapeHtml(post.selftext.slice(0, 4000))}</div>` : ""}
          <h4 style="margin:14px 0 6px">Top comments (${comments.length})</h4>
          <div class="comment-list">
            ${comments.length ? topComments.map((c) => `
              <div class="comment">
                <div class="meta">u/${Util.escapeHtml(c.author || "")} · ${Util.fmtNum(c.score)} pts · ${c.replies} replies · ${Util.escapeHtml(Util.relTime(c.created_utc))}</div>
                <div>${Util.escapeHtml((c.body || "").slice(0, 480))}${(c.body || "").length > 480 ? "…" : ""}</div>
              </div>
            `).join("") : '<div class="empty">No comments returned.</div>'}
          </div>
        </div>
        <div>
          <dl class="kv">
            <dt>ID</dt><dd><code>${Util.escapeHtml(post.id)}</code></dd>
            <dt>Score</dt><dd>${Util.fmtNum(post.score)} (${post.ups != null ? Util.fmtNum(post.ups) + " ups" : "—"})</dd>
            <dt>Upvote ratio</dt><dd>${post.upvote_ratio == null ? "—" : Util.fmtPct(post.upvote_ratio)}</dd>
            <dt>Comments</dt><dd>${Util.fmtNum(post.num_comments)}</dd>
            <dt>Awards</dt><dd>${Util.fmtNum(post.total_awards)}</dd>
            <dt>Views</dt><dd>${post.view_count == null ? "<em>hidden</em>" : Util.fmtNum(post.view_count)}</dd>
            <dt>Domain</dt><dd>${Util.escapeHtml(post.domain || "")}</dd>
            <dt>URL</dt><dd><a href="${Util.escapeHtml(post.url || "")}" target="_blank" rel="noopener">${Util.escapeHtml((post.url || "").slice(0, 70))}</a></dd>
            <dt>Permalink</dt><dd><a href="${Util.escapeHtml(post.permalink)}" target="_blank" rel="noopener">old.reddit thread</a></dd>
            <dt>Posted</dt><dd>${Util.escapeHtml(Util.fmtDateShort(post.created_utc))} UTC</dd>
            <dt>Comment sentiment</dt><dd>${commentSent.positive} pos / ${commentSent.negative} neg / ${commentSent.neutral} neu</dd>
          </dl>
        </div>
      </div>
    `;
  };

  UI.hidePostDetail = function () {
    const card = document.getElementById("post-detail");
    if (card) card.hidden = true;
  };

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
    el.innerHTML = groups.slice(0, 20).map((g) => `
      <div class="crosspost-row">
        <strong>${Util.escapeHtml(g.kind === "url" ? truncate(g.key, 90) : truncate(g.posts[0].title, 110))}</strong>
        <span class="badge info">${g.posts.length} posts</span>
        <div class="subs">${g.subs.map((s) => `r/${Util.escapeHtml(s)}`).join(" · ")} · ${Util.fmtNum(g.totalScore)} pts · ${Util.fmtNum(g.totalComments)} comments</div>
      </div>
    `).join("");
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

  UI.renderCampaignList = function (campaigns, summaries, onOpen) {
    const el = document.getElementById("campaign-list");
    if (!el) return;
    if (!campaigns.length) { el.innerHTML = '<div class="empty">No campaigns yet. Add one on the left to track a list of cross-posts toward a goal.</div>'; return; }
    el.innerHTML = "";
    for (const c of campaigns) {
      const summary = summaries[c.id] || {};
      const totalScore = summary.totalScore || 0;
      const totalComments = summary.totalComments || 0;
      const progress = c.goalScore ? Math.min(1, totalScore / c.goalScore) : 0;
      const card = document.createElement("div");
      card.className = "campaign-card";
      card.innerHTML = `
        <div>
          <div><strong>${Util.escapeHtml(c.name)}</strong></div>
          <div class="meta">${c.postIds.length} post IDs · ${Util.fmtNum(totalScore)} pts · ${Util.fmtNum(totalComments)} comments${c.goalScore ? ` · goal ${Util.fmtNum(c.goalScore)}` : ""}</div>
        </div>
        <div class="progress">
          <div class="progress-bar"><span style="width:${(progress * 100).toFixed(1)}%"></span></div>
          <div class="meta" style="text-align:right;margin-top:2px">${c.goalScore ? Math.round(progress * 100) + "%" : "—"}</div>
        </div>
      `;
      card.addEventListener("click", () => onOpen(c));
      el.appendChild(card);
    }
  };

  UI.renderCampaignDetail = function (campaign, agg) {
    const card = document.getElementById("campaign-detail");
    const title = document.getElementById("campaign-detail-title");
    const body = document.getElementById("campaign-detail-body");
    if (!card) return;
    card.hidden = false;
    title.textContent = campaign.name;

    const goalScorePct = campaign.goalScore ? Math.min(1, agg.totalScore / campaign.goalScore) : null;
    const goalCommentsPct = campaign.goalComments ? Math.min(1, agg.totalComments / campaign.goalComments) : null;

    const subList = agg.subs.map((s) => `r/${Util.escapeHtml(s)}`).join(", ") || "—";
    const postsTable = agg.posts.length ? `
      <div class="table-wrap" style="margin-top:12px">
        <table>
          <thead><tr><th>ID</th><th>Sub</th><th>Title</th><th class="num">Score</th><th class="num">UV %</th><th class="num">Comments</th><th>When</th></tr></thead>
          <tbody>
            ${agg.posts.map((p) => `
              <tr>
                <td><code>${Util.escapeHtml(p.id)}</code></td>
                <td>r/${Util.escapeHtml(p.subreddit)}</td>
                <td><a href="${Util.escapeHtml(p.permalink)}" target="_blank" rel="noopener">${Util.escapeHtml((p.title || "").slice(0, 90))}</a></td>
                <td class="num">${Util.fmtNum(p.score)}</td>
                <td class="num">${p.upvote_ratio == null ? "—" : Util.fmtPct(p.upvote_ratio)}</td>
                <td class="num">${Util.fmtNum(p.num_comments)}</td>
                <td>${Util.escapeHtml(Util.relTime(p.created_utc))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    ` : '<div class="empty" style="margin-top:12px">No posts found yet — fetch failed or IDs are invalid.</div>';

    const missingNote = agg.missing && agg.missing.length
      ? `<div class="meta" style="color:var(--warn);margin-top:6px">Could not resolve: ${agg.missing.map((id) => `<code>${Util.escapeHtml(id)}</code>`).join(", ")}</div>`
      : "";

    body.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="label">Posts tracked</div><div class="value">${campaign.postIds.length}</div><div class="sub">${agg.posts.length} resolved</div></div>
        <div class="kpi"><div class="label">Total upvotes</div><div class="value">${Util.fmtNum(agg.totalScore)}</div><div class="sub">${campaign.goalScore ? "goal " + Util.fmtNum(campaign.goalScore) : "no goal set"}</div></div>
        <div class="kpi"><div class="label">Total comments</div><div class="value">${Util.fmtNum(agg.totalComments)}</div><div class="sub">${campaign.goalComments ? "goal " + Util.fmtNum(campaign.goalComments) : "no goal set"}</div></div>
        <div class="kpi"><div class="label">Total awards</div><div class="value">${Util.fmtNum(agg.totalAwards)}</div><div class="sub">across resolved posts</div></div>
        <div class="kpi"><div class="label">Subreddits hit</div><div class="value">${agg.subs.length}</div><div class="sub">${Util.escapeHtml(subList)}</div></div>
        <div class="kpi"><div class="label">Views</div><div class="value">${agg.totalViews ? Util.fmtNum(agg.totalViews) : "—"}</div><div class="sub">${agg.totalViews ? "where reported" : "Reddit hides this for non-owners"}</div></div>
      </div>
      ${goalScorePct != null ? `<div style="margin-top:8px"><div class="meta">Score progress (${Math.round(goalScorePct * 100)}%)</div><div class="progress-bar"><span style="width:${(goalScorePct * 100).toFixed(1)}%"></span></div></div>` : ""}
      ${goalCommentsPct != null ? `<div style="margin-top:8px"><div class="meta">Comment progress (${Math.round(goalCommentsPct * 100)}%)</div><div class="progress-bar"><span style="width:${(goalCommentsPct * 100).toFixed(1)}%"></span></div></div>` : ""}
      ${missingNote}
      ${postsTable}
    `;
  };

  UI.hideCampaignDetail = function () {
    const card = document.getElementById("campaign-detail");
    if (card) card.hidden = true;
  };

  UI.activateTab = function (name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  };

  function truncate(s, n) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  window.UI = UI;
})();
