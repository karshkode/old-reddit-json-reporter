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

  UI.renderKpis = function (agg, timing) {
    const row = document.getElementById("kpi-row");
    if (!row) return;
    const kpis = [
      { label: "Posts", value: Util.fmtNum(agg.count), sub: agg.viewsKnown ? `${agg.viewsKnown} with view counts` : "in window" },
      { label: "Total upvotes", value: Util.fmtNum(agg.totalScore), sub: `avg ${Util.fmtNum(agg.avgScore)} · median ${Util.fmtNum(agg.medianScore)}` },
      { label: "Total comments", value: Util.fmtNum(agg.totalComments), sub: `avg ${Util.fmtNum(agg.avgComments)} per post` },
      { label: "Avg upvote ratio", value: agg.avgUpvoteRatio == null ? "—" : Util.fmtPct(agg.avgUpvoteRatio), sub: "Reddit-reported sentiment" },
      (function () {
        /* The next slot worth acting on, scoped to a real community
         * rather than to the pool. Pooling every loaded sub into one
         * histogram used to produce an hour that suited none of them,
         * and a bare hour label gave no sense of when to actually do
         * anything. This tile names the community, the quarter hour
         * and how long away it is; the full breakdown lives in the
         * per-subreddit timing card. */
        const tz = (typeof Util.getTzLabel === "function") ? Util.getTzLabel() : "";
        const lead = timing && timing.nextUp;
        if (!lead) {
          const measured = (timing && timing.measured) || [];
          return {
            label: "Next posting slot",
            value: "—",
            sub: measured.length
              ? `no time-of-day effect in ${measured.length === 1 ? "the measured community" : `any of ${measured.length} communities`}`
              : timing ? `needs ${timing.minSample}+ posts in one sub` : "needs more posts",
          };
        }
        const when = (lead.slotLabel || "—") + (tz ? " " + tz : "");
        const bits = [`r/${Util.escapeHtml(lead.subreddit)}`];
        if (lead.next) bits.push(lead.next.inLabel.replace(/^in /, ""));
        if (lead.lift > 0) bits.push(`+${lead.lift}%`);
        return { label: "Next posting slot", value: when, sub: bits.join(" · ") };
      })(),
      { label: "Top score", value: Util.fmtNum(agg.topPost ? agg.topPost.score : 0), sub: agg.topPost ? `r/${Util.escapeHtml(agg.topPost.subreddit)}` : "" },
    ];
    row.innerHTML = kpis.map((k) => `
      <div class="stat">
        <div class="stat-label">${Util.escapeHtml(k.label)}</div>
        <div class="stat-value">${k.value}</div>
        <div class="stat-sub">${k.sub}</div>
      </div>
    `).join("");
  };

  /* ---------- Posting times, per subreddit ---------- */

  const DOW_SHORT = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function hhmm(h) {
    return String(h).padStart(2, "0") + ":00";
  }

  function signed(v) {
    return (v > 0 ? "+" : "") + Math.round(v) + "%";
  }

  /* The clock time a row recommends. Falls back to the hour label for
   * rows assembled before the quarter-hour model existed. */
  function slotOf(r) {
    return r.slotLabel || (r.bestHour >= 0 ? hhmm(r.bestHour) : "—");
  }

  /* Everything the estimate rests on, collapsed into a hover/long-press
   * title. The visible row stays scannable; the justification is one
   * gesture away rather than four lines of prose away. */
  function evidenceTitle(r) {
    const bits = [];
    if (r.liftLow != null && r.liftHigh != null) {
      bits.push(`Typical post scores ${signed(r.lift)} against this community's own baseline (95% CI ${signed(r.liftLow)} to ${signed(r.liftHigh)})`);
    }
    if (r.window && r.window.slots < Timing.SLOTS) {
      bits.push(`Statistically tied window ${Timing.windowLabel(r)} — any minute inside it is as good`);
    }
    if (r.effectiveN != null) {
      bits.push(`${r.effectiveN.toFixed(1)} effective posts inside a ${r.bandwidthHours.toFixed(1)}h smoothing window`);
    }
    if (r.ratioAt != null && r.ratioBase != null) {
      bits.push(`Upvote ratio ${Util.fmtPct(r.ratioAt)} at that moment against ${Util.fmtPct(r.ratioBase)} overall`);
    }
    if (r.ratioDecided) {
      bits.push("Reception picked the minute inside the tied window");
    }
    if (r.clipped) {
      bits.push(`${r.clipped} extreme score${r.clipped === 1 ? "" : "s"} capped, so a single breakout post cannot set the peak`);
    }
    if (r.excluded) {
      bits.push(`${r.excluded} pinned or removed post${r.excluded === 1 ? "" : "s"} left out`);
    }
    if (r.p != null) {
      bits.push(`Permutation test against ${r.permutations || 250} reshuffles of the same posts: ${Timing.pLabel(r.p)}`);
    }
    return bits.join(". ");
  }

  /* Signal strength as a word, not a colour alone. */
  function signalBadge(r) {
    if (!r.signal || r.signal === "none") return "";
    const cls = r.signal === "strong" ? "good" : r.signal === "likely" ? "" : "warn";
    return `<span class="badge ${cls} timing-signal">${Util.escapeHtml(Timing.signalLabel(r.signal))}</span>`;
  }

  /* The one-line justification under each community. Ordered by how
   * much it should change your mind: effect size, then how much data
   * is behind it, then whether the shuffle test believed it. */
  function timingFacts(r) {
    if (r.ambient) {
      return `read from the sub's own ${Util.fmtNum(r.count)} loaded posts — your ${r.campaignCount} campaign post${r.campaignCount === 1 ? "" : "s"} there ${r.campaignCount === 1 ? "is" : "are"} too few to measure`;
    }
    const bits = [];
    if (r.lift > 0) {
      /* The interval is not optional detail. A "+50%" that could just
       * as easily be -8% is a different instruction from a "+50%"
       * that bottoms out at +20%, and only one of them is worth
       * rearranging an afternoon for. */
      bits.push(`<strong>${signed(r.lift)}</strong> on a typical post`
        + (r.liftLow != null ? ` <span class="timing-ci">(${signed(r.liftLow)} to ${signed(r.liftHigh)})</span>` : ""));
    }
    if (r.effectiveN != null) bits.push(`${r.effectiveN.toFixed(0)} posts nearby`);
    if (r.p != null) bits.push(Util.escapeHtml(Timing.pLabel(r.p)));
    if (r.ratioAt != null && r.ratioBase != null && Math.abs(r.ratioAt - r.ratioBase) >= 0.01) {
      bits.push(`${Util.fmtPct(r.ratioAt)} ratio ${r.ratioAt > r.ratioBase ? "up from" : "down from"} ${Util.fmtPct(r.ratioBase)}`);
    }
    if (r.dowName) bits.push(`best on ${Util.escapeHtml(r.dowName)}`);
    if (r.next) bits.push(Util.escapeHtml(r.next.inLabel));
    return bits.join(" · ");
  }

  /* Communities whose scores demonstrably do not depend on posting
   * time. Saying so is more useful than inventing a peak for them. */
  function flatNote(model) {
    if (!model.flat || !model.flat.length) return "";
    const names = model.flat.map((r) => `<span class="tag">r/${Util.escapeHtml(r.subreddit)}</span>`).join(" ");
    return `<p class="timing-skipped">No time-of-day effect worth acting on in ${names} — across ${model.flat.length === 1 ? "its" : "their"} loaded posts, score does not track the clock. Post when the draft is ready.</p>`;
  }

  /* The compact all-communities list. Deliberately not the Timing
   * tab: one line per community, the quarter hour, and just enough
   * numbers to tell a finding from a coincidence. */
  UI.timingListHtml = function (model, opts) {
    opts = opts || {};
    const tz = model.tz ? ` ${Util.escapeHtml(model.tz)}` : "";
    const all = model.ranked || [];
    const limit = opts.limit === "all" ? all.length : (opts.limit || all.length);
    const rows = all.slice(0, limit);
    const hidden = all.length - rows.length;
    return `
      <ul class="timing-summary">
        ${rows.map((r) => `
          <li data-signal="${Util.escapeHtml(r.signal || "none")}" title="${Util.escapeHtml(evidenceTitle(r))}">
            <span class="timing-sub">r/${Util.escapeHtml(r.subreddit)}${signalBadge(r)}</span>
            <span class="timing-peak">${Util.escapeHtml(slotOf(r))}${tz}</span>
            <span class="timing-facts">${timingFacts(r)}</span>
          </li>`).join("")}
      </ul>
      ${hidden > 0 ? `<div class="timing-more"><button class="btn small ghost" type="button" data-action="show-all-timing">Show ${hidden} more communit${hidden === 1 ? "y" : "ies"}</button></div>` : ""}`;
  };

  /* Small multiples, one community per panel. The alternative — a
   * single chart with a line per sub — was unreadable past four subs,
   * and the whole point of this card is that the subs differ. */
  UI.renderPostingTimes = function (model, opts) {
    const host = document.getElementById("posting-times");
    if (!host) return;
    opts = opts || {};
    if (window.Charts && Charts.destroyIn) Charts.destroyIn(host);

    if (!model || !model.rows.length) {
      host.innerHTML = Dom.emptyState({
        icon: "◔",
        title: "No posting times yet",
        body: "Load some posts and each community gets its own hour-by-hour panel here.",
      });
      return;
    }

    const tz = model.tz ? ` ${Util.escapeHtml(model.tz)}` : "";
    const ranked = model.ranked;
    const limit = opts.limit === "all" ? ranked.length : (opts.limit || 6);
    const shown = ranked.slice(0, limit);
    const hidden = ranked.length - shown.length;

    let lead;
    if (!ranked.length && model.measured && model.measured.length) {
      lead = `Score does not track the clock in ${model.measured.length === 1 ? "the one community with enough posts" : `any of the ${model.measured.length} communities with enough posts`}. Reshuffling the same posts against the same timestamps produces day curves as uneven as the real one, so there is no hour here worth waiting for.`;
    } else if (!ranked.length) {
      lead = `None of your ${model.rows.length} communities has ${model.minSample} posts loaded yet — that is the floor for calling a slot a peak rather than a coincidence.`;
    } else if (ranked.length === 1) {
      lead = `<strong>r/${Util.escapeHtml(ranked[0].subreddit)}</strong> peaks at <strong>${Util.escapeHtml(slotOf(ranked[0]))}${tz}</strong>. Load a second community to compare.`;
    } else if (model.agree) {
      lead = `Unusually, all ${ranked.length} communities peak within <strong>${model.spreadMinutes} minutes</strong> of each other — one posting slot will serve all of them.`;
    } else {
      lead = `These ${ranked.length} communities peak up to <strong>${model.spread} hours</strong> apart, so there is no single best time. Post into each one on its own clock.`;
    }

    host.innerHTML = `
      <p class="timing-lead">${lead}</p>
      <div class="timing-grid">
        ${shown.map((r) => timingPanel(r, tz)).join("")}
      </div>
      ${hidden > 0 ? `<div class="timing-more"><button class="btn small ghost" type="button" data-action="show-all-timing">Show ${hidden} more communit${hidden === 1 ? "y" : "ies"}</button></div>` : ""}
      ${flatNote(model)}
      ${model.skipped.length ? `
        <p class="timing-skipped">
          Not enough posts to call a peak in
          ${model.skipped.map((r) => `<span class="tag">r/${Util.escapeHtml(r.subreddit)} <em>${r.count}</em></span>`).join(" ")}
          — needs ${model.minSample}.
        </p>` : ""}
    `;

    if (!window.Charts || !window.Chart) return;
    for (const row of shown) {
      const slot = host.querySelector(`[data-timing-chart="${CSS.escape(row.key)}"]`);
      if (!slot) continue;
      try {
        Charts.mount(slot, { kind: "hourHeat", data: row.agg, opts: { compact: true } });
      } catch (err) {
        console.warn(`[timing] r/${row.subreddit}:`, err && err.message);
      }
    }
  };

  /* Text-only version, for places that already draw an hour chart per
   * subreddit further down the page and only need the headline. */
  UI.postingTimesSummaryHtml = function (model, opts) {
    opts = opts || {};
    if (!model) return "";
    if (!model.ranked.length) {
      if (model.measured && model.measured.length) {
        return `<p class="timing-lead">Nothing here posts better at one time than another. ${model.measured.length === 1 ? "The one community" : `All ${model.measured.length} communities`} with enough posts to test came back flat — shuffling the scores across the same timestamps produces day curves just as uneven as the real one.</p>${flatNote(model)}`;
      }
      return `<p class="timing-lead">No community here has ${model.minSample} posts yet, so a peak would be a coin flip. Add more of the campaign's posts, or load the subreddit itself to borrow its ambient rhythm.</p>`;
    }
    const borrowed = model.ranked.filter((r) => r.ambient).length;
    const lead = (model.agree
      ? `All ${model.ranked.length} communities peak within ${model.spreadMinutes} minutes of each other.`
      : model.ranked.length === 1
        ? `One community has a time-of-day effect worth acting on.`
        : `Peaks are up to <strong>${model.spread} hours</strong> apart — there is no one time that serves all of these.`)
      + (borrowed ? ` ${borrowed} of these ${borrowed === 1 ? "is" : "are"} read from the subreddit's own traffic rather than your posts.` : "");

    return `
      <p class="timing-lead">${lead}</p>
      ${UI.timingListHtml(model, { limit: opts.limit || 6 })}
      ${flatNote(model)}
      ${model.skipped.length ? `<p class="timing-skipped">Too few posts to measure: ${model.skipped.map((r) => `<span class="tag">r/${Util.escapeHtml(r.subreddit)} <em>${r.count}</em></span>`).join(" ")}</p>` : ""}`;
  };

  function timingPanel(r, tz) {
    const facts = [];
    if (r.lift > 0) {
      facts.push(`<strong>${signed(r.lift)}</strong> on a typical post${r.liftLow != null ? ` (95% CI ${signed(r.liftLow)} to ${signed(r.liftHigh)})` : ""}`);
    }
    if (r.window && r.window.slots < Timing.SLOTS) facts.push(`tied window ${Timing.windowLabel(r)}`);
    if (r.effectiveN != null) facts.push(`${r.effectiveN.toFixed(0)} of ${Util.fmtNum(r.count)} posts near that time`);
    if (r.p != null) facts.push(Util.escapeHtml(Timing.pLabel(r.p)));
    if (r.ratioAt != null && r.ratioBase != null) {
      facts.push(`${Util.fmtPct(r.ratioAt)} upvote ratio there vs ${Util.fmtPct(r.ratioBase)}`);
    }
    if (r.dowName) facts.push(`best on ${Util.escapeHtml(r.dowName)}${r.dowLift > 0 ? ` (${signed(r.dowLift)})` : ""}`);
    else if (r.bestDow >= 0) facts.push(`busiest on ${DOW_SHORT[r.bestDow]}`);
    if (r.velocityHour >= 0 && Math.abs(r.velocityHour - r.bestHour) >= 2) {
      facts.push(`fastest early traction at ${hhmm(r.velocityHour)}`);
    }
    if (r.quiet) facts.push(`dead ${hhmm(r.quiet.start)}–${hhmm(r.quiet.end)}`);
    if (r.next) facts.push(`next ${Util.escapeHtml(r.next.label)}`);

    /* A negatively correlated reception curve means the slot that
     * scores best is also the one drawing the most downvotes — worth
     * saying rather than burying. */
    const caution = (r.ratioCorr != null && r.ratioCorr < -0.3)
      ? `<span class="badge warn timing-thin">scores well, received worse</span>`
      : "";

    return `
      <div class="timing-panel" data-sub="${Util.escapeHtml(r.key)}" data-signal="${Util.escapeHtml(r.signal || "none")}">
        <div class="timing-panel-head">
          <span class="timing-sub">r/${Util.escapeHtml(r.subreddit)}${signalBadge(r)}</span>
          <span class="timing-peak">${Util.escapeHtml(slotOf(r))}${tz}</span>
        </div>
        ${r.confidence === "thin" ? `<span class="badge warn timing-thin">thin sample — ${r.count} posts</span>` : ""}
        ${caution}
        <div class="chart-wrap short" data-timing-chart="${Util.escapeHtml(r.key)}"><canvas></canvas></div>
        <div class="timing-facts">${facts.join(" · ")}</div>
      </div>`;
  }

  /* ---------- Posts table ---------- */

  UI.renderPostsTable = function (posts, sortKey, sortDir, onRowClick, opts) {
    const tbody = document.getElementById("posts-tbody");
    const count = document.getElementById("posts-count");
    if (!tbody) return;
    if (count) count.textContent = posts.length;
    /* Slice to the requested page if opts.pageSize is a number; "all" or
     * undefined renders every row (legacy callers untouched). */
    opts = opts || {};
    const pageSize = opts.pageSize;
    const page = Math.max(0, opts.page || 0);
    const visible = (pageSize == null || pageSize === "all") ? posts : posts.slice(page * pageSize, (page + 1) * pageSize);

    document.querySelectorAll("#posts-table thead th").forEach((th) => {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (th.dataset.sort === sortKey) {
        th.classList.add(sortDir === "asc" ? "sorted-asc" : "sorted-desc");
      }
    });

    if (!posts.length) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty">No posts match the current filter.</div></td></tr>`;
      return;
    }
    if (!visible.length) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty">No posts on this page — try Prev or change filters.</div></td></tr>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const p of visible) {
      const tr = document.createElement("tr");
      tr.dataset.id = p.id;
      tr.tabIndex = 0;
      tr.setAttribute("role", "button");
      /* The 9th column is an inline action button — "+ Campaign". Click
       * doesn't bubble to the row's onRowClick because we stop
       * propagation in the click handler. The action expands an inline
       * form-row below this <tr> (see UI.renderPostMakeCampaignForm). */
      /* Reddit-native quality flags (already in main from PR 1).
       * Stickied / pinned posts get an organic boost from mods and
       * shouldn't be conflated with breakouts; removed posts have
       * no real engagement; NSFW + spoilers carry warnings. */
      const flagBadges = [];
      if (p.stickied) flagBadges.push('<span class="tag flag-stickied" title="Mod-pinned — organic-boost outlier">📌 pinned</span>');
      if (p.removed)  flagBadges.push('<span class="tag flag-removed" title="Removed by mods or author">🗑 removed</span>');
      if (p.over_18)  flagBadges.push('<span class="tag flag-nsfw" title="NSFW">NSFW</span>');
      if (p.spoiler)  flagBadges.push('<span class="tag flag-spoiler" title="Spoiler">spoiler</span>');
      if (p.locked)   flagBadges.push('<span class="tag flag-locked" title="Comments locked">🔒 locked</span>');
      const flagsHtml = flagBadges.length ? ` ${flagBadges.join(" ")}` : "";

      /* Thumbnail (PR 3) — Reddit returns a thumbnail URL on link/image
       * posts via media_thumbnail (oEmbed) or directly. Only render when
       * we have a real http(s) URL; Reddit-internal placeholders like
       * 'self' / 'default' / 'nsfw' / 'spoiler' are not URLs. */
      let thumbHtml = "";
      const mediaUrl = p.media_thumbnail || (p.thumbnail && /^https?:\/\//.test(p.thumbnail) ? p.thumbnail : null);
      if (mediaUrl && !p.over_18) {
        thumbHtml = `<button type="button"
          class="post-thumb"
          data-media-thumb="${Util.escapeHtml(mediaUrl)}"
          data-media-alt="${Util.escapeHtml(p.title || "")}"
          aria-label="Preview media"
          title="Preview media without leaving the dashboard"><img src="${Util.escapeHtml(mediaUrl)}" alt="" loading="lazy" /></button>`;
      }

      /* Title cell: the title text is a real <a> linking to the
       * post on Reddit so the user can open the source post in
       * one tap from the table. Click on the title -> opens
       * Reddit in a new tab. Click ANYWHERE ELSE in the row ->
       * opens the in-dashboard detail pane (charts / sentiment
       * / comments analysis), preserving the prior row-click
       * affordance. The exclusion list in the row's click
       * handler below keeps the two from firing simultaneously. */
      /* "When" cell shows BOTH the relative age ("2h ago") and the
       * actual local clock time ("14:23"). Helps the user spot
       * whether a sub's apparent "best post hour" is actually
       * just where the front-page rotation puts older posts —
       * staring at a column of "2h ago · 02:14" / "5h ago · 23:01"
       * makes the timing pattern (or lack of one) immediately
       * legible. Hover for the full date. */
      const whenAge = Util.escapeHtml(Util.relTime(p.created_utc));
      const whenClock = Util.escapeHtml(Util.fmtClockTime(p.created_utc));
      tr.innerHTML = `
        <td data-label="When" title="${Util.escapeHtml(Util.fmtDateShort(p.created_utc))} ${Util.escapeHtml(Util.getTzLabel())}">
          <div class="when-age">${whenAge}</div>
          ${whenClock ? `<div class="when-clock">${whenClock}</div>` : ""}
        </td>
        <td data-label="Sub"><span class="tag">r/${Util.escapeHtml(p.subreddit)}</span></td>
        <td data-label="Title" class="title">
          ${thumbHtml}
          <a class="title-text"
             href="${Util.escapeHtml(p.permalink || "")}"
             target="_blank"
             rel="noopener"
             title="Open in Reddit \u2197 (click row body to expand details)"
             data-post-link="${Util.escapeHtml(p.id)}">${Util.escapeHtml(p.title || "")}<span class="title-link-icon" aria-hidden="true">\u2197</span></a>
          ${p.flair ? `<span class="tag flair">${Util.escapeHtml(p.flair)}</span>` : ""}${flagsHtml}
        </td>
        <td data-label="Author">${Util.escapeHtml(p.author || "")}</td>
        <td data-label="Score" class="num">${Util.fmtNum(p.score)}</td>
        <td data-label="UV %" class="num">${p.upvote_ratio == null ? "—" : Util.fmtPct(p.upvote_ratio)}</td>
        <td data-label="Comments" class="num">${Util.fmtNum(p.num_comments)}</td>
        <td data-label="ID"><code>${Util.escapeHtml(p.id)}</code></td>
        <td data-label="Action" class="row-action">
          <button class="btn small primary"
                  type="button"
                  data-action="make-campaign-from-post"
                  data-post-id="${Util.escapeHtml(p.id)}"
                  title="Create a campaign from this post and search for recommended subreddits to cross-post to"
                  aria-label="Make a campaign from this post">+ Campaign</button>
        </td>
      `;
      tr.addEventListener("click", (ev) => {
        /* Skip the row-click → detail-pane behavior when the
         * click was actually on:
         *   - a.title-text         (opens Reddit permalink)
         *   - .post-thumb          (opens media-preview modal)
         *   - the + Campaign button + its inline form
         *
         * Without these exclusions the title-link's new-tab open
         * would also expand the detail pane underneath, which is
         * confusing — the user sees their click open Reddit AND
         * the detail card scroll into focus simultaneously. */
        if (ev.target.closest && ev.target.closest('[data-action="make-campaign-from-post"], .post-make-form, .post-make-form-row, a.title-text, .post-thumb')) return;
        onRowClick(p);
      });
      tr.addEventListener("keydown", (e) => {
        if (e.target !== tr) return; /* let buttons / inputs handle keys */
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(p); }
      });
      frag.appendChild(tr);
    }
    tbody.innerHTML = "";
    tbody.appendChild(frag);
  };

  /* ---------- One post → its spheres → related communities ---------- */

  /* Rendered in two places from one function: the post detail panel
   * (full, with per-row add buttons) and the make-campaign form
   * (compact, as a preview of what the campaign will inherit). */
  UI.renderPostRelated = function (host, result, opts) {
    if (!host) return;
    opts = opts || {};
    if (!result) {
      host.innerHTML = `<div class="post-related-status">${Dom.skeleton(3)}</div>`;
      return;
    }

    const spheres = result.spheres || [];
    const communities = (result.communities || []).filter((c) => opts.includeLoaded !== false || !c.loaded);
    const shown = communities.slice(0, opts.limit || (opts.compact ? 6 : 10));

    if (!spheres.length && !shown.length) {
      host.innerHTML = `<p class="post-related-status">Nothing in the catalog reads like this post. Try the Communities search, or add the post to a campaign and run full discovery — that reaches Reddit's own search as well.</p>`;
      return;
    }

    const sphereChips = spheres.map((s) => `
      <button class="chip sphere-suggestion" type="button" data-action="load-sphere-from-post" data-sphere="${Util.escapeHtml(s.key)}"
              title="Load every community in this sphere">
        ${Util.escapeHtml(s.label)}<span class="chip-meta">${s.confidence}%</span>
      </button>`).join("");

    host.innerHTML = `
      ${spheres.length ? `
        <div class="post-related-block">
          <div class="post-related-label">Reads as</div>
          <div class="sphere-suggestions">${sphereChips}</div>
        </div>` : ""}
      ${shown.length ? `
        <div class="post-related-block">
          <div class="post-related-label">
            ${spheres.length ? "Communities those spheres reach" : "Related communities"}
            <span class="hint">${result.resolved} of ${result.pool} candidates had a description to read</span>
          </div>
          <ul class="post-related-list">
            ${shown.map((c) => relatedRow(c, opts)).join("")}
          </ul>
        </div>` : ""}
      ${opts.actions === false ? "" : `
        <div class="post-related-actions">
          <button class="btn small" type="button" data-action="load-related-subs">Load the checked communities</button>
          <button class="btn small primary" type="button" data-action="campaign-from-detail" data-post-id="${Util.escapeHtml(result.post.id)}">Make a campaign from this post</button>
        </div>`}
    `;
  };

  function relatedRow(c, opts) {
    const rec = c.record || {};
    const size = c.stub
      ? "catalog entry, description not read yet"
      : rec.subscribers ? `${Util.fmtNum(rec.subscribers)} members` : "size unknown";
    const via = c.viaSphere ? ` · via ${Util.escapeHtml(c.viaSphere)}` : "";
    const reason = (c.reasons && c.reasons[0]) || "";
    /* Pre-check only the rows that share actual vocabulary with the
     * post. A sphere sibling with no overlap is worth showing but not
     * worth loading on the user's behalf. */
    const checked = !c.loaded && c.overlapTerms && c.overlapTerms.length > 0;
    return `
      <li class="post-related-row${c.loaded ? " is-loaded" : ""}">
        <label class="post-related-pick">
          <input type="checkbox" data-related-sub="${Util.escapeHtml(c.name)}" ${c.loaded ? "disabled" : ""} ${checked ? "checked" : ""} />
          <span class="post-related-name">r/${Util.escapeHtml(c.name)}</span>
        </label>
        <span class="post-related-score" title="Match score out of 100">${c.score}</span>
        <span class="post-related-meta">${size}${via}${c.loaded ? " · already loaded" : ""}</span>
        ${opts.compact ? "" : `<span class="post-related-reason">${reason}</span>`}
      </li>`;
  }

  /* Insert an inline form-row below `rowEl` (the post's <tr>) so the
   * user can name a campaign + set goals before saving. The form-row
   * is itself a <tr><td colspan="9"> so the table layout stays sane.
   * Mirrors the cross-post → campaign form pattern. */
  UI.renderPostMakeCampaignForm = function (rowEl, post, opts) {
    if (!rowEl || !post) return;
    opts = opts || {};
    UI.dismissPostMakeCampaignForm(rowEl);

    const formRow = document.createElement("tr");
    formRow.className = "post-make-form-row";
    formRow.dataset.forPost = post.id;
    const cell = document.createElement("td");
    cell.colSpan = 9;
    cell.innerHTML = UI.postMakeCampaignFormHtml(post);
    formRow.appendChild(cell);

    rowEl.classList.add("editing");
    rowEl.parentNode.insertBefore(formRow, rowEl.nextSibling);

    if (opts.focus !== false) {
      const nameInput = formRow.querySelector('input[data-field="name"]');
      if (nameInput) {
        try { nameInput.focus(); nameInput.select(); } catch (_) {}
      }
    }
    return formRow;
  };

  /* The same form outside a table, for the post detail panel. */
  UI.renderPostMakeCampaignInline = function (host, post, opts) {
    if (!host || !post) return null;
    opts = opts || {};
    host.hidden = false;
    host.innerHTML = UI.postMakeCampaignFormHtml(post, { inheritRelated: true });
    const nameInput = host.querySelector('input[data-field="name"]');
    if (opts.focus !== false && nameInput) {
      try { nameInput.focus(); nameInput.select(); } catch (_) {}
    }
    return host.querySelector(".post-make-form");
  };

  /* The name a campaign gets when it is minted from a post. Kept short
   * enough to stay a heading: at 60 characters of title it ran to five
   * lines in the workspace header on a phone. Cut on a word boundary so
   * it reads as a truncated headline rather than a severed one. */
  UI.campaignNameForPost = function (post) {
    const title = String((post && post.title) || "Untitled").trim();
    let trimmed = title.slice(0, 38);
    if (title.length > 38) {
      const space = trimmed.lastIndexOf(" ");
      if (space > 20) trimmed = trimmed.slice(0, space);
      trimmed += "…";
    }
    return `From r/${(post && post.subreddit) || "reddit"}: ${trimmed}`;
  };

  UI.postMakeCampaignFormHtml = function (post, opts) {
    opts = opts || {};
    const defaultName = UI.campaignNameForPost(post);
    /* Suggest goals as ~1.5× the post's current performance. */
    function niceCeil(n) {
      if (n <= 0) return 0;
      const target = n * 1.5;
      const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(target)) - 1));
      return Math.ceil(target / mag) * mag;
    }
    const suggestedScore = niceCeil(post.score || 0);
    const suggestedComments = niceCeil(post.num_comments || 0);

    return `
      <form class="post-make-form" data-post-id="${Util.escapeHtml(post.id)}">
        <div class="pmf-headline">
          <strong>Make a campaign from this post</strong>
          <span class="meta">The campaign tracks this post, opens its workspace, and runs full discovery against Reddit's own search — wider than the catalog-only match below.</span>
        </div>
        <div class="pmf-row">
          <label class="full">
            <span class="group-label">Campaign name</span>
            <input type="text" data-field="name" value="${Util.escapeHtml(defaultName)}" required maxlength="120" />
          </label>
        </div>
        <div class="pmf-row">
          <label>
            <span class="group-label">Goal upvotes</span>
            <input type="number" data-field="goalScore" min="0" inputmode="numeric" placeholder="optional" value="${suggestedScore || ""}" />
          </label>
          <label>
            <span class="group-label">Goal comments</span>
            <input type="number" data-field="goalComments" min="0" inputmode="numeric" placeholder="optional" value="${suggestedComments || ""}" />
          </label>
        </div>
        ${opts.inheritRelated ? "" : `<div class="pmf-related" data-role="pmf-related"></div>`}
        <label class="pmf-check">
          <input type="checkbox" data-field="loadRelated" checked />
          <span>Also load the communities checked ${opts.inheritRelated ? "above" : "here"}, so the dashboard shows each one's own posting times</span>
        </label>
        <div class="pmf-meta">
          Tracking <strong>1</strong> post · current: <strong>${Util.fmtNum(post.score)}</strong> pts · <strong>${Util.fmtNum(post.num_comments)}</strong> comments · in r/${Util.escapeHtml(post.subreddit)}
        </div>
        <div class="pmf-actions">
          <button type="button" class="btn small ghost" data-action="cancel-make-campaign-from-post">Cancel</button>
          <button type="submit" class="btn small primary" data-action="confirm-make-campaign-from-post">Save &amp; find subreddits</button>
        </div>
      </form>`;
  };

  UI.dismissPostMakeCampaignForm = function (rowEl) {
    if (!rowEl) return;
    rowEl.classList.remove("editing");
    const next = rowEl.nextSibling;
    if (next && next.classList && next.classList.contains("post-make-form-row")) {
      next.parentNode.removeChild(next);
    }
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
    /* Comment-side analysis (PR 4) */
    const tempInfo = Analysis.threadTemperature ? Analysis.threadTemperature(comments) : null;
    const objections = Analysis.extractObjections ? Analysis.extractObjections(comments, { limit: 5 }) : [];
    const brigading = Analysis.detectBrigading ? Analysis.detectBrigading(comments) : null;
    const velocity = Analysis.commentVelocity ? Analysis.commentVelocity(comments, post.created_utc) : null;
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

          ${renderCommentSideAnalysisBlock(tempInfo, objections, brigading, velocity, comments.length)}

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

      <section class="post-related-card" id="post-related">
        <header class="post-related-header">
          <div>
            <h4>Where else this post could go</h4>
            <span class="hint">Matched against the issue-sphere catalog and every community description already cached — no campaign needed</span>
          </div>
          <button class="card-help" type="button" aria-label="How this works"
                  data-help="The post's title, flair and body become a term vector, which is ranked against every issue sphere in the catalog. The winning spheres bring their member communities, the home subreddit's own spheres bring their siblings, and anything with a similar cached description is added too. Each community is then scored on shared vocabulary, sphere fit, civic language and activity. Check the ones you want and load them, or turn the whole thing into a campaign.">?</button>
        </header>
        <ol class="post-related-howto">
          <li>Check the communities worth reaching — the score is out of 100, and every row says why it matched.</li>
          <li><strong>Load the checked communities</strong> pulls their posts, which is what gives each one its own posting-time panel on the Dashboard.</li>
          <li><strong>Make a campaign from this post</strong> does that and tracks the post, then runs full discovery against Reddit's search for communities the catalog does not know.</li>
        </ol>
        <div id="post-related-body"></div>
        <div id="post-related-form" hidden></div>
      </section>
    `;
  };

  /* Comment-side analysis block (PR 4). Renders inside the post-detail
   * card. Hidden if there are no comments. Surfaces:
   *   - thread temperature (hostile/mixed/supportive/flat) with a tally
   *   - top objection phrases
   *   - brigading suspicion score + reasons (if non-zero)
   *   - comment velocity ("alive" tag if last-hour rate matches lifetime) */
  function renderCommentSideAnalysisBlock(temp, objections, brigading, velocity, commentCount) {
    if (!commentCount || !temp) return "";
    const tempCls = temp.label === "supportive" ? "good"
                  : temp.label === "hostile"   ? "bad"
                  : temp.label === "mixed"     ? "warn" : "info";
    const tempIcon = temp.label === "supportive" ? "🌱" : temp.label === "hostile" ? "🔥" : temp.label === "mixed" ? "⚖️" : "•";
    const objHtml = (objections || []).length
      ? `<div class="csa-line"><span class="csa-label">Top objections</span>
          <div class="csa-objections">${objections.map((o) => `<span class="csa-obj">"${Util.escapeHtml(o.phrase)}"</span>`).join("")}</div></div>`
      : "";
    const brigCls = brigading && brigading.score >= 60 ? "bad" : brigading && brigading.score >= 30 ? "warn" : "";
    const brigHtml = brigading && brigading.score >= 30
      ? `<div class="csa-line csa-brigading ${brigCls}">
          <span class="csa-label">Brigading watch</span>
          <span class="badge ${brigCls}">suspicion ${brigading.score}/100</span>
          <ul>${brigading.reasons.map((r) => `<li>${Util.escapeHtml(r)}</li>`).join("")}</ul>
        </div>`
      : "";
    const velHtml = velocity
      ? `<div class="csa-line csa-velocity">
          <span class="csa-label">Velocity</span>
          <span class="meta">${velocity.perHour}/hr · ${velocity.total} total · age ${velocity.ageHours.toFixed(1)}h${velocity.alive ? ' · <span class="badge good">🟢 alive</span>' : ' · <span class="badge info">💤 idle</span>'}</span>
        </div>`
      : "";
    return `
      <div class="comment-side-analysis">
        <div class="csa-head">
          <span class="badge ${tempCls}">${tempIcon} ${Util.escapeHtml(temp.label)}</span>
          <span class="meta">${temp.support} support · ${temp.oppose} oppose · ${temp.neutral} neutral</span>
        </div>
        ${objHtml}
        ${brigHtml}
        ${velHtml}
      </div>
    `;
  }

  /* Predict + rewrite block (PR 5). Renders inside the campaign
   * detail panel as a small inline tool: paste a draft title, see
   * predicted score in this campaign's loaded subs at their peak
   * hours, plus 3 rephrasing variants. */
  UI.renderPredictAndRewrite = function (container) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) return;
    el.innerHTML = `
      <div class="predict-tool">
        <div class="predict-head">
          <strong>What if I posted this?</strong>
          <span class="hint">Paste a draft title — we'll guess how it'd land in each loaded sub at its peak hour, plus 3 rephrasings.</span>
        </div>
        <input type="text" data-role="predict-draft" placeholder="Your draft title…" maxlength="300" />
        <div class="predict-results" data-role="predict-results"></div>
        <div class="rewrite-results" data-role="rewrite-results"></div>
      </div>
    `;
  };

  UI.renderPredictResults = function (container, predictions, rewrites) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) return;
    const presEl = el.querySelector('[data-role="predict-results"]');
    const rewEl  = el.querySelector('[data-role="rewrite-results"]');
    if (presEl) {
      if (!predictions || !predictions.length) {
        presEl.innerHTML = "";
      } else {
        presEl.innerHTML = `<div class="predict-list">${predictions.map((p) => {
          const cls = p.confidence === "high" ? "good" : p.confidence === "medium" ? "info" : "warn";
          if (p.expectedMid == null) {
            return `<div class="predict-row"><span class="ps-sub">r/${Util.escapeHtml(p.sub)}</span><span class="meta">${Util.escapeHtml(p.message || "insufficient data")}</span></div>`;
          }
          return `<div class="predict-row">
            <span class="ps-sub">r/${Util.escapeHtml(p.sub)}</span>
            <span class="ps-range"><strong>${Util.fmtNum(p.expectedLow)}–${Util.fmtNum(p.expectedHigh)}</strong> pts</span>
            <span class="ps-mid">~${Util.fmtNum(p.expectedMid)}</span>
            <span class="badge ${cls}">${p.confidence}</span>
            <span class="ps-hour meta">peak ${String(p.hour).padStart(2,"0")}:00</span>
          </div>`;
        }).join("")}</div>`;
      }
    }
    if (rewEl) {
      if (!rewrites || !rewrites.length) {
        rewEl.innerHTML = "";
      } else {
        rewEl.innerHTML = `
          <div class="rewrite-head"><strong>Try a different angle</strong></div>
          ${rewrites.map((r) => `
            <div class="rewrite-row">
              <button class="btn small ghost" type="button" data-rewrite-pick="${Util.escapeHtml(r.title)}" title="Use this variant">${Util.escapeHtml(r.style)}</button>
              <span class="rewrite-title">${Util.escapeHtml(r.title)}</span>
              <span class="meta">${Util.escapeHtml(r.hint)}</span>
            </div>
          `).join("")}
        `;
      }
    }
  };

  /* Cascade scheduler block (PR 5). Shows the staggered posting
   * order recommended for a list of subs. */
  UI.renderCascadeSchedule = function (container, schedule) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) return;
    if (!schedule || !schedule.length) {
      el.innerHTML = '<div class="empty">Need at least one loaded sub with a peak hour to plan a cascade.</div>';
      return;
    }
    const fmtTime = (d) => {
      try { return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }); }
      catch (_) { return String(d); }
    };
    el.innerHTML = `
      <div class="cascade-list">
        ${schedule.map((s, i) => {
          const cls = s.confidence === "high" ? "good" : s.confidence === "medium" ? "info" : "warn";
          const gapBit = i === 0 ? "" : `<span class="meta">+${s.gapMinutes}m later</span>`;
          return `
            <div class="cascade-row">
              <span class="cascade-index">${i + 1}.</span>
              <span class="cascade-time"><strong>${Util.escapeHtml(fmtTime(s.targetTime))}</strong></span>
              <span class="cascade-sub">r/${Util.escapeHtml(s.sub)}</span>
              <span class="cascade-pred">~${Util.fmtNum(s.predictedScore)} pts</span>
              <span class="badge ${cls}">${s.confidence}</span>
              ${gapBit}
            </div>
          `;
        }).join("")}
      </div>
      <div class="cascade-hint meta">Staggered to avoid overlap; one sub per slot, ≥60min gap. Times in your local zone.</div>
    `;
  };

  /* Campaign A/B comparison rendering (PR 6). */
  UI.renderCampaignCompare = function (container, comparison) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) return;
    if (!comparison) { el.innerHTML = '<div class="empty">Pick two campaigns above to compare.</div>'; return; }
    const { A, B, insights } = comparison;
    function statTile(label, valA, valB, fmt) {
      fmt = fmt || ((v) => Util.fmtNum(v));
      const aHigher = valA > valB;
      return `
        <div class="ab-tile">
          <div class="ab-label">${Util.escapeHtml(label)}</div>
          <div class="ab-values">
            <span class="${aHigher ? "ab-higher" : ""}">${fmt(valA)}</span>
            <span class="ab-vs">vs</span>
            <span class="${!aHigher && valA !== valB ? "ab-higher" : ""}">${fmt(valB)}</span>
          </div>
        </div>
      `;
    }
    el.innerHTML = `
      <div class="ab-head">
        <div class="ab-name ab-a">${Util.escapeHtml(A.name)}</div>
        <span class="meta">vs</span>
        <div class="ab-name ab-b">${Util.escapeHtml(B.name)}</div>
      </div>
      ${insights.length ? `<ul class="ab-insights">${insights.map((i) => `<li>${i}</li>`).join("")}</ul>` : ""}
      <div class="ab-stats">
        ${statTile("Posts", A.posts.length, B.posts.length)}
        ${statTile("Total upvotes", A.totalScore, B.totalScore)}
        ${statTile("Total comments", A.totalComments, B.totalComments)}
        ${statTile("Avg score", Math.round(A.avgScore), Math.round(B.avgScore))}
        ${statTile("Subs reached", A.subCount, B.subCount)}
        ${statTile("Sentiment", A.sentiment.average, B.sentiment.average, (v) => v.toFixed(2))}
      </div>
      ${(comparison.themes.intersect.length + comparison.themes.aOnly.length + comparison.themes.bOnly.length) ? `
        <div class="ab-themes">
          <div class="ab-themes-col">
            <div class="ab-themes-h">${Util.escapeHtml(A.name)} only</div>
            <div>${comparison.themes.aOnly.slice(0, 8).map((t) => `<span class="kw">${Util.escapeHtml(t)}</span>`).join("") || '<span class="meta">—</span>'}</div>
          </div>
          <div class="ab-themes-col">
            <div class="ab-themes-h">Shared</div>
            <div>${comparison.themes.intersect.slice(0, 8).map((t) => `<span class="kw shared">${Util.escapeHtml(t)}</span>`).join("") || '<span class="meta">—</span>'}</div>
          </div>
          <div class="ab-themes-col">
            <div class="ab-themes-h">${Util.escapeHtml(B.name)} only</div>
            <div>${comparison.themes.bOnly.slice(0, 8).map((t) => `<span class="kw">${Util.escapeHtml(t)}</span>`).join("") || '<span class="meta">—</span>'}</div>
          </div>
        </div>` : ""}
    `;
  };

  /* Watch mode badge — small toggle-able pill on the campaign detail.
   * The actual setInterval lives in app.js; this just renders state. */
  UI.renderWatchToggle = function (container, isOn, intervalMin) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) return;
    el.innerHTML = `
      <button type="button" class="watch-toggle ${isOn ? "on" : "off"}" data-action="toggle-watch" aria-pressed="${isOn ? "true" : "false"}">
        <span class="watch-dot"></span>
        ${isOn ? `Watching · auto-refresh every ${intervalMin}m` : "Watch (auto-refresh)"}
      </button>
    `;
  };

  /* Calendar / planning view (PR 6). Renders campaigns onto a 14-day
   * strip with goal-progress bars. Each campaign card is clickable to
   * open the underlying detail. */
  UI.renderCampaignCalendar = function (container, campaigns, summaries) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) return;
    if (!campaigns || !campaigns.length) {
      el.innerHTML = '<div class="empty">No campaigns yet. Create one to see it on the calendar.</div>';
      return;
    }
    /* Today + previous 6 days + future 7 days = 14 cells */
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cells = [];
    for (let i = -6; i <= 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      cells.push(d);
    }
    function dayLabel(d) {
      try { return d.toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" }); }
      catch (_) { return d.toDateString(); }
    }
    /* Each campaign rendered as a row with goal-progress bar. */
    const rows = campaigns.map((c) => {
      const summary = summaries[c.id] || {};
      const created = c.createdAt ? new Date(c.createdAt) : null;
      const totalScore = summary.totalScore || 0;
      const goalScore = c.goalScore || 0;
      const pctScore = goalScore ? Math.min(1, totalScore / goalScore) : 0;
      const startCellIdx = created
        ? cells.findIndex((d) => d >= new Date(created.getFullYear(), created.getMonth(), created.getDate()))
        : 0;
      const startIdx = startCellIdx < 0 ? 0 : startCellIdx;
      return `
        <div class="cal-row" data-campaign-id="${Util.escapeHtml(c.id)}">
          <div class="cal-name" title="${Util.escapeHtml(c.name)}">${Util.escapeHtml(c.name)}</div>
          <div class="cal-strip">
            ${cells.map((d, i) => `<div class="cal-cell${i === 6 ? " today" : ""}${i >= startIdx ? " active" : ""}" title="${Util.escapeHtml(dayLabel(d))}"></div>`).join("")}
          </div>
          <div class="cal-progress" title="${goalScore ? Math.round(pctScore * 100) + '% of ' + Util.fmtNum(goalScore) + ' upvote goal' : 'No goal set'}">
            <div class="cal-progress-bar"><span style="width:${(pctScore * 100).toFixed(1)}%"></span></div>
            <span class="meta">${goalScore ? Math.round(pctScore * 100) + "%" : Util.fmtNum(totalScore) + " pts"}</span>
          </div>
        </div>
      `;
    }).join("");
    el.innerHTML = `
      <div class="cal-head">
        <div class="cal-name-h"></div>
        <div class="cal-strip-h">
          ${cells.map((d, i) => `<div class="cal-cell-h${i === 6 ? " today" : ""}">${Util.escapeHtml(d.getDate().toString())}</div>`).join("")}
        </div>
        <div class="cal-progress-h">Goal</div>
      </div>
      ${rows}
      <div class="cal-hint meta">14-day strip — past 6 days + today + next 7. Today highlighted.</div>
    `;
  };

  /* Volunteer coordination — claim subs to post to (PR 6).
   * Local-only; multi-device sync via the existing share-link
   * mechanism. State lives in localStorage. */
  UI.renderVolunteerCoverage = function (container, claims, candidateSubs, currentName) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) return;
    if (!candidateSubs || !candidateSubs.length) {
      el.innerHTML = '<div class="empty">Pick a campaign and run Discover so we have a candidate sub list to coordinate around.</div>';
      return;
    }
    const claimMap = {};
    for (const c of (claims || [])) claimMap[c.sub.toLowerCase()] = c;
    el.innerHTML = `
      <div class="vol-head">
        <label>Your name <input id="vol-name" type="text" value="${Util.escapeHtml(currentName || "")}" placeholder="anon" maxlength="30" /></label>
        <span class="meta">${Object.keys(claimMap).length} of ${candidateSubs.length} subs claimed</span>
      </div>
      <div class="vol-list">
        ${candidateSubs.map((s) => {
          const claim = claimMap[s.toLowerCase()];
          if (claim) {
            const mine = currentName && claim.name === currentName;
            return `<div class="vol-row claimed">
              <span class="vol-sub">r/${Util.escapeHtml(s)}</span>
              <span class="vol-claim">claimed by <strong>${Util.escapeHtml(claim.name)}</strong></span>
              ${mine ? `<button class="btn small ghost" type="button" data-action="vol-unclaim" data-sub="${Util.escapeHtml(s)}">Release</button>` : ""}
            </div>`;
          }
          return `<div class="vol-row open">
            <span class="vol-sub">r/${Util.escapeHtml(s)}</span>
            <button class="btn small primary" type="button" data-action="vol-claim" data-sub="${Util.escapeHtml(s)}">Claim</button>
          </div>`;
        }).join("")}
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

  UI.renderCrossPosts = function (groups, opts) {
    const el = document.getElementById("crossposts");
    if (!el) return;
    opts = opts || {};
    if (!groups.length) {
      el.innerHTML = '<div class="empty">No cross-posts match the current filter.</div>';
      return;
    }
    const pageSize = opts.pageSize;
    const page = Math.max(0, opts.page || 0);
    const visible = (pageSize == null || pageSize === "all") ? groups : groups.slice(page * pageSize, (page + 1) * pageSize);
    if (!visible.length) {
      el.innerHTML = '<div class="empty">No cross-posts on this page — try Prev or change filters.</div>';
      return;
    }
    /* Default visible rows when the user expands a group. Anything
     * beyond this gets hidden behind a "Show all N" inner expander —
     * a typical YouTube link can collect 40+ cross-posts and rendering
     * all of them every time was the dominant scroll-creep on the
     * Campaigns tab. */
    const POSTS_VISIBLE_PER_GROUP = 5;

    el.innerHTML = visible.map((g) => {
      const spread = g.subs.length;
      const tier = spread >= 5 ? "good" : spread >= 3 ? "warn" : "info";
      const cpIndex = g._origIndex != null ? g._origIndex : 0;

      /* Headline picker.
       *
       *   kind=title  -> the (already-shared) post title is the key
       *   kind=url    -> the URL is the key, but a raw URL is a poor
       *                  headline. Prefer (in order):
       *                    1. media.oembed.title from any post in the
       *                       group (actual YouTube/Vimeo/article title)
       *                    2. the most-common post title across the
       *                       group (more readable than a single
       *                       arbitrary one)
       *                    3. fall back to the URL truncated
       *
       *  We also surface the source (provider + URL host) as a small
       *  meta line so the user can still see what was shared without
       *  needing to expand the group. */
      let headline, source = "";
      if (g.kind === "title") {
        headline = truncate(g.posts[0].title || g.key, 110);
      } else {
        let mediaTitle = null, mediaProvider = null, mediaAuthor = null;
        for (const p of g.posts) {
          if (p.media_title) {
            mediaTitle = p.media_title;
            mediaProvider = p.media_provider;
            mediaAuthor = p.media_author;
            break;
          }
        }
        if (mediaTitle) {
          headline = truncate(mediaTitle, 110);
          /* Compact source line: "YouTube · Channel name · youtube.com" */
          const bits = [];
          if (mediaProvider) bits.push(mediaProvider);
          if (mediaAuthor) bits.push(mediaAuthor);
          try {
            const host = new URL(g.key).host.replace(/^www\./, "");
            if (host && !bits.some((b) => String(b).toLowerCase().includes(host.split(".")[0]))) {
              bits.push(host);
            }
          } catch (_) {}
          source = bits.join(" · ");
        } else {
          /* No oEmbed title — pick the most common post title. */
          const titleCounts = {};
          for (const p of g.posts) {
            const t = (p.title || "").trim();
            if (t) titleCounts[t] = (titleCounts[t] || 0) + 1;
          }
          const top = Object.entries(titleCounts).sort((a, b) => b[1] - a[1])[0];
          if (top && top[0]) {
            headline = truncate(top[0], 110);
            try {
              const host = new URL(g.key).host.replace(/^www\./, "");
              if (host) source = host;
            } catch (_) {}
          } else {
            headline = truncate(g.key, 90);
          }
        }
      }

      /* Per-post mini-rows. Sorted by score; truncated to top
       * POSTS_VISIBLE_PER_GROUP behind a "Show all N" inner expander.
       * Each row is a single-line link to the live thread. */
      const sortedPosts = g.posts.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
      const truncated = sortedPosts.length > POSTS_VISIBLE_PER_GROUP;
      function renderRow(p) {
        return `
          <a class="crosspost-post-row"
             href="${Util.escapeHtml(p.permalink)}"
             target="_blank" rel="noopener"
             title="Open in Reddit">
            <span class="cpp-sub">r/${Util.escapeHtml(p.subreddit)}</span>
            <span class="cpp-score">▲ ${Util.fmtNum(p.score)}</span>
            <span class="cpp-comments">💬 ${Util.fmtNum(p.num_comments)}</span>
            <span class="cpp-uv">${p.upvote_ratio == null ? "" : Util.fmtPct(p.upvote_ratio) + " UV"}</span>
            <span class="cpp-when">${Util.escapeHtml(Util.relTime(p.created_utc))}</span>
          </a>
        `;
      }
      const initialRowsHtml  = sortedPosts.slice(0, POSTS_VISIBLE_PER_GROUP).map(renderRow).join("");
      const overflowRowsHtml = truncated
        ? `<div class="crosspost-posts-overflow" hidden>${sortedPosts.slice(POSTS_VISIBLE_PER_GROUP).map(renderRow).join("")}</div>`
        : "";
      const innerExpander = truncated
        ? `<button type="button"
                   class="list-expand crosspost-show-more"
                   data-action="toggle-crosspost-overflow"
                   data-cp-index="${cpIndex}"
                   aria-expanded="false">
             <span class="show-label">+ ${sortedPosts.length - POSTS_VISIBLE_PER_GROUP} more — show all ${sortedPosts.length}</span>
             <span class="hide-label">Show top ${POSTS_VISIBLE_PER_GROUP} only</span>
           </button>`
        : "";

      const sourceHtml = source
        ? `<div class="crosspost-source meta">${Util.escapeHtml(source)}</div>`
        : "";

      return `
        <div class="crosspost-row" data-spread="${spread}" data-cp-index="${cpIndex}">
          <div class="crosspost-head">
            <strong>${Util.escapeHtml(headline)}</strong>
            <span class="badge ${tier}" title="Cross-posted across ${spread} subreddits">in ${spread} sub${spread === 1 ? "" : "s"}</span>
          </div>
          ${sourceHtml}
          <div class="subs">${g.subs.map((s) => `r/${Util.escapeHtml(s)}`).join(" · ")} · ${Util.fmtNum(g.totalScore)} pts · ${Util.fmtNum(g.totalComments)} comments</div>
          <div class="crosspost-actions">
            <button class="btn small ghost"
                    type="button"
                    data-action="toggle-crosspost-posts"
                    data-cp-index="${cpIndex}"
                    aria-expanded="false">
              <span class="show-label">▾ Show ${truncated ? "top " + POSTS_VISIBLE_PER_GROUP : sortedPosts.length} of ${sortedPosts.length}</span>
              <span class="hide-label">▴ Hide</span>
            </button>
            <button class="btn small primary"
                    type="button"
                    data-action="make-campaign-from-crosspost"
                    data-cp-index="${cpIndex}"
                    aria-label="Convert this cross-post group into a new campaign">+ Make campaign</button>
          </div>
          <div class="crosspost-posts" hidden>
            ${initialRowsHtml}
            ${overflowRowsHtml}
            ${innerExpander}
          </div>
          <div class="crosspost-form-slot"></div>
        </div>
      `;
    }).join("");
  };

  /* Render an inline "Set goals + Save" form into a crosspost-row when
   * the user taps "+ Make campaign". This replaces the action-button row
   * with a small form so the user can choose goals before committing. */
  UI.renderCrossPostMakeCampaignForm = function (rowEl, group, opts) {
    if (!rowEl || !group) return;
    opts = opts || {};
    const slot = rowEl.querySelector(".crosspost-form-slot");
    const actions = rowEl.querySelector(".crosspost-actions");
    if (!slot) return;

    const titleSrc = group.kind === "url" ? group.key : (group.posts[0] && group.posts[0].title) || "Cross-post";
    const trimmed = String(titleSrc).slice(0, 60).trim();
    const defaultName = `Cross-post: ${trimmed}${trimmed.length === 60 ? "…" : ""}`;
    /* Suggest goals as roughly 1.5× the current totals — a stretch but
     * not absurd. Round to a nice number. */
    function niceCeil(n) {
      if (n <= 0) return 0;
      const target = n * 1.5;
      const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(target)) - 1));
      return Math.ceil(target / mag) * mag;
    }
    const suggestedScore = niceCeil(group.totalScore || 0);
    const suggestedComments = niceCeil(group.totalComments || 0);

    if (actions) actions.classList.add("hidden-during-edit");

    slot.innerHTML = `
      <form class="crosspost-make-form" data-cp-index="${rowEl.dataset.cpIndex || ""}">
        <div class="cmf-row">
          <label class="full">
            <span class="group-label">Campaign name</span>
            <input type="text" data-field="name" value="${Util.escapeHtml(defaultName)}" required maxlength="120" />
          </label>
        </div>
        <div class="cmf-row">
          <label>
            <span class="group-label">Goal upvotes</span>
            <input type="number" data-field="goalScore" min="0" inputmode="numeric" placeholder="optional" value="${suggestedScore || ""}" />
          </label>
          <label>
            <span class="group-label">Goal comments</span>
            <input type="number" data-field="goalComments" min="0" inputmode="numeric" placeholder="optional" value="${suggestedComments || ""}" />
          </label>
        </div>
        <div class="cmf-meta">
          ${group.posts.length} post${group.posts.length === 1 ? "" : "s"} across ${group.subs.length} sub${group.subs.length === 1 ? "" : "s"} · current totals: <strong>${Util.fmtNum(group.totalScore)}</strong> pts · <strong>${Util.fmtNum(group.totalComments)}</strong> comments
        </div>
        <div class="cmf-actions">
          <button type="button" class="btn small ghost" data-action="cancel-make-campaign">Cancel</button>
          <button type="submit" class="btn small primary" data-action="confirm-make-campaign">Save campaign</button>
        </div>
      </form>
    `;
    /* Focus the name input so keyboard users can edit it immediately. */
    const nameInput = slot.querySelector('input[data-field="name"]');
    if (nameInput && opts.focus !== false) {
      try { nameInput.focus(); nameInput.select(); } catch (_) {}
    }
  };

  UI.dismissCrossPostMakeCampaignForm = function (rowEl) {
    if (!rowEl) return;
    const slot = rowEl.querySelector(".crosspost-form-slot");
    const actions = rowEl.querySelector(".crosspost-actions");
    if (slot) slot.innerHTML = "";
    if (actions) actions.classList.remove("hidden-during-edit");
  };

  /* The dashboard summary: one labelled row per finding, so the card is
   * read by scanning the left column rather than by reading prose. */
  UI.renderBriefing = function (rows) {
    const el = document.getElementById("dash-briefing");
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = `<p class="hint">Nothing to summarise yet.</p>`;
      return;
    }
    el.innerHTML = rows.map((r) => `
      <li>
        <span class="briefing-label">${Util.escapeHtml(r.label)}</span>
        <span class="briefing-body">
          <span class="briefing-value">${r.value}</span>
          ${r.note ? `<span class="briefing-note">${r.note}</span>` : ""}
          ${r.timing ? `<span class="briefing-timing">${UI.timingListHtml(r.timing, { limit: "all" })}</span>` : ""}
        </span>
      </li>`).join("");
  };

  /* ---------- Themes ---------- */

  UI.renderThemes = function (themes) {
    const el = document.getElementById("themes");
    if (!el) return;
    if (!themes || !themes.length) {
      el.innerHTML = '<div class="empty">Not enough variety to identify themes.</div>';
      return;
    }
    /* Show the top N first; the rest is hidden behind a "Show all"
     * button. Lets the user scan the most-important themes without
     * scrolling past 14 rows of low-relevance noise. State is held in
     * the DOM via data-truncated so re-renders don't lose the user's
     * choice unexpectedly. */
    const TRUNC = 5;
    const max = Math.min(14, themes.length);
    const showAll = el.dataset.truncated === "false";
    const visible = (showAll || max <= TRUNC) ? themes.slice(0, max) : themes.slice(0, TRUNC);
    el.dataset.truncated = (showAll || max <= TRUNC) ? "false" : "true";
    const expanderHtml = max > TRUNC && !showAll
      ? `<button type="button" class="list-expand" data-action="expand-themes">Show all ${max} themes</button>`
      : (max > TRUNC && showAll
          ? `<button type="button" class="list-expand" data-action="collapse-themes">Show top ${TRUNC} only</button>`
          : "");
    el.innerHTML = visible.map((t) => {
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
    }).join("") + expanderHtml;

    /* Wire the expand/collapse button (re-renders the same list with
     * the inverted truncated state). One-shot — re-attached on every
     * render because innerHTML clobbers it. */
    const btn = el.querySelector('[data-action="expand-themes"], [data-action="collapse-themes"]');
    if (btn) {
      btn.addEventListener("click", () => {
        el.dataset.truncated = el.dataset.truncated === "true" ? "false" : "true";
        UI.renderThemes(themes);
      });
    }
  };

  /* ---------- Subreddit profiles ---------- */

  UI.renderSubProfiles = function (profiles) {
    const el = document.getElementById("sub-profiles");
    if (!el) return;
    const list = Object.values(profiles || {});
    if (!list.length) { el.innerHTML = '<div class="empty">Load at least one subreddit to see profiles.</div>'; return; }
    list.sort((a, b) => b.totalScore - a.totalScore);
    /* Show the top 3 by total upvotes; rest hidden behind "Show all".
     * 3 is enough to spot the headline patterns without becoming a
     * scroll-fest. State stored on the element via data-truncated so
     * re-renders preserve the user's choice. */
    const TRUNC = 3;
    const max = list.length;
    const showAll = el.dataset.truncated === "false";
    const visible = (showAll || max <= TRUNC) ? list : list.slice(0, TRUNC);
    el.dataset.truncated = (showAll || max <= TRUNC) ? "false" : "true";
    const expanderHtml = max > TRUNC && !showAll
      ? `<button type="button" class="list-expand" data-action="expand-profiles">Show all ${max} subreddits</button>`
      : (max > TRUNC && showAll
          ? `<button type="button" class="list-expand" data-action="collapse-profiles">Show top ${TRUNC} only</button>`
          : "");
    el.innerHTML = visible.map((p) => {
      const sentClass = p.sentiment.average > 0.1 ? "good" : p.sentiment.average < -0.1 ? "bad" : "info";
      const sentLabel = p.sentiment.average > 0.1 ? "positive" : p.sentiment.average < -0.1 ? "negative" : "neutral";
      const recCls = p.reception === "warm" ? "good" : p.reception === "healthy" ? "info" : p.reception === "mixed" ? "warn" : p.reception === "contentious" ? "bad" : "info";
      const themes = (p.themes || []).slice(0, 5).map((t) => `<span class="kw">${t.kind === "phrase" ? `"${Util.escapeHtml(t.term)}"` : Util.escapeHtml(t.term)}<span class="count">${t.count}</span></span>`).join("");
      const keys = (p.keywords || []).slice(0, 8).map((k) => `<span class="tag">${Util.escapeHtml(k.word)}</span>`).join(" ");
      /* Health metrics (PR 2). Quick-scan signals beyond the headline:
       * velocity tells you whether the sub is busy (>10/hr) or quiet;
       * karma skew is the breakout-vs-broadly-engaged signal;
       * stickyShare flags subs whose baseline is inflated by mod
       * boost (their "median" is misleading). */
      const velLabel = p.velocityPerHour >= 10 ? "🔥 busy"
                     : p.velocityPerHour >= 1  ? "🟢 active"
                     : p.velocityPerHour >= 0.1 ? "🟡 quiet"
                                               : "💤 dormant";
      const skewLabel = p.karmaSkew >= 20 ? "all-or-nothing — a few posts run away with all the karma"
                      : p.karmaSkew >= 8  ? "skewed — a few breakouts dominate"
                      : p.karmaSkew >= 3  ? "mixed — most posts modest, occasional hit"
                                          : "broadly engaged — even median posts get traction";
      const stickyWarn = p.stickyShare >= 0.05
        ? `<span class="badge warn" title="Mod-pinned posts inflate the baseline metrics for this sub.">${Math.round(p.stickyShare * 100)}% pinned</span>`
        : "";
      const removedWarn = p.removedShare >= 0.05
        ? `<span class="badge bad" title="${Math.round(p.removedShare * 100)}% of loaded posts were removed by mods or authors. Heavy-moderation sub.">${Math.round(p.removedShare * 100)}% removed</span>`
        : "";
      const nsfwBadge = p.nsfwShare >= 0.20
        ? `<span class="badge warn" title="${Math.round(p.nsfwShare * 100)}% of loaded posts are flagged NSFW.">NSFW-heavy</span>`
        : "";

      return `
        <div class="profile-card">
          <div class="profile-head">
            <h3>r/${Util.escapeHtml(p.subreddit || p.label)}</h3>
            <div class="profile-badges">
              <span class="badge ${sentClass}">${sentLabel}</span>
              <span class="badge ${recCls}">${p.reception}</span>
              <span class="badge info">${p.style}</span>
              <span class="badge info" title="Velocity: ${p.velocityPerHour.toFixed(2)} posts/hour over the loaded window">${velLabel}</span>
              ${stickyWarn}${removedWarn}${nsfwBadge}
            </div>
          </div>
          <div class="profile-stats">
            <div><span class="label">Posts</span><strong>${Util.fmtNum(p.count)}</strong></div>
            <div><span class="label">Median score</span><strong>${Util.fmtNum(p.medianScore)}</strong></div>
            <div><span class="label">P90 score</span><strong>${Util.fmtNum(p.karmaP90)}</strong></div>
            <div><span class="label">Avg comments</span><strong>${Util.fmtNum(p.avgComments)}</strong></div>
            <div><span class="label">UV ratio</span><strong>${p.avgUpvoteRatio == null ? "—" : Util.fmtPct(p.avgUpvoteRatio)}</strong></div>
            <div><span class="label">Velocity</span><strong>${p.velocityPerHour < 1 ? p.velocityPerHour.toFixed(2) : Math.round(p.velocityPerHour)}/hr</strong></div>
            <div title="Hour with highest AVERAGE SCORE for posts submitted at that hour (in your local timezone). Note: biased toward hours where posts have had more time to accrue score in any /hot snapshot — compare with the velocity-peak below to spot bias.">
              <span class="label">Peak hour <span class="info-icon" aria-hidden="true">ⓘ</span></span>
              <strong>${p.bestHour >= 0 ? String(p.bestHour).padStart(2, "0") + ":00" : "—"}</strong>
            </div>
            <div title="Hour with highest SCORE-PER-HOUR-OF-AGE — divides each post's score by its age (floored at 30min) so older posts don't automatically dominate. If this disagrees with the raw 'Peak hour' above, the peak signal is likely a survivorship artifact.">
              <span class="label">Velocity peak <span class="info-icon" aria-hidden="true">ⓘ</span></span>
              <strong>${p.bestHourByVelocity >= 0 ? String(p.bestHourByVelocity).padStart(2, "0") + ":00" : "—"}</strong>
            </div>
            <div><span class="label">Best day</span><strong>${Analysis.DAY_NAMES[p.bestDow].slice(0, 3)}</strong></div>
          </div>
          ${(p.bestHour >= 0 && p.bestHourByVelocity >= 0 && Math.abs(p.bestHour - p.bestHourByVelocity) >= 4) ? `
            <div class="profile-line profile-bias-warn" title="Raw 'Peak hour' is computed from average score; older posts skew it because they've had more hours to accumulate score. Velocity divides by post age so it penalizes that. A >4-hour gap between the two often means the raw peak is just where the front-page rotation parked older posts.">
              <span class="profile-label">⚠️ Timing bias</span>
              <span class="meta">Raw peak (<strong>${String(p.bestHour).padStart(2, "0")}:00</strong>) and velocity peak (<strong>${String(p.bestHourByVelocity).padStart(2, "0")}:00</strong>) disagree by ${Math.abs(p.bestHour - p.bestHourByVelocity)}h — the raw peak may be a survivorship artifact. Trust the velocity peak.</span>
            </div>
          ` : ""}
          <div class="profile-line profile-skew" title="Karma skew = P90 / P50. Higher = breakout-driven; near 1 = broadly engaged.">
            <span class="profile-label">Engagement shape</span>
            <span class="meta">${Util.escapeHtml(skewLabel)} <span class="profile-skew-num">(skew ${p.karmaSkew >= 100 ? "100+" : p.karmaSkew.toFixed(1)})</span></span>
          </div>
          ${p.quietHours && p.quietHours.length >= 4 ? `
            <div class="profile-line profile-quiet" title="Hours with zero loaded posts — likely dead-air windows.">
              <span class="profile-label">Quiet hours</span>
              <span class="meta">${p.quietHours.map((h) => String(h).padStart(2, "0") + ":00").join(" · ")}</span>
            </div>` : ""}
          ${themes ? `<div class="profile-line"><span class="profile-label">Themes</span><div class="keyword-cloud">${themes}</div></div>` : ""}
          ${keys ? `<div class="profile-line"><span class="profile-label">Top words</span><div>${keys}</div></div>` : ""}
        </div>
      `;
    }).join("") + expanderHtml;

    const btn = el.querySelector('[data-action="expand-profiles"], [data-action="collapse-profiles"]');
    if (btn) {
      btn.addEventListener("click", () => {
        el.dataset.truncated = el.dataset.truncated === "true" ? "false" : "true";
        UI.renderSubProfiles(profiles);
      });
    }
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

    /* Paging — opts.paging = { page, pageSize }. surfaceKey threads
     * through to the data-attrs so the click handler can route page
     * changes back to the correct slot in state.recommend.targeting.
     * Default pageSize 25 matches the Posts table for consistency. */
    const surfaceKey = opts.surfaceKey || "default";
    const pageSize = (opts.paging && opts.paging.pageSize) || 25;
    const page = (opts.paging && opts.paging.page) || 0;
    const total = targets.length;
    const isAll = pageSize === "all";
    const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages - 1);
    const slice = isAll ? targets : targets.slice(safePage * pageSize, (safePage + 1) * pageSize);

    const head = opts.heading
      ? `<div class="meta" style="margin-bottom:8px">Best loaded subreddits for <strong>${Util.escapeHtml(campaign.name)}</strong>, ranked by theme overlap, sentiment alignment, audience reception, and activity.</div>`
      : "";

    const cards = slice.map((t, i) => {
      const absRank = (isAll ? 0 : safePage * pageSize) + i + 1;
      const cls = t.score >= 70 ? "good" : t.score >= 50 ? "info" : t.score >= 30 ? "warn" : "bad";
      const reasonsHtml = t.reasons.map((r) => `<li>${r}</li>`).join("");
      const segments = `
        <div class="meter-list">
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
              <span class="rank">#${absRank}</span>
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

    /* Top controls: page-size selector + result count.
     * Bottom controls: prev/next pager.
     * Both omitted when total <= 10 (no need to paginate a tiny list). */
    const showControls = total > 10;
    const sizeChips = ["10", "25", "50", "100", "all"].map((sz) => {
      const isOn = String(pageSize) === sz;
      const label = sz === "all" ? "All" : sz;
      return `<button type="button" class="chip${isOn ? " active" : ""}" data-targeting-size="${sz}" data-targeting-surface="${Util.escapeHtml(surfaceKey)}" role="radio" aria-checked="${isOn}">${label}</button>`;
    }).join("");
    const sizeRow = showControls ? `
      <div class="recommend-controls">
        <span class="meta"><strong>${Util.fmtNum(total)}</strong> recommended sub${total === 1 ? "" : "s"}</span>
        <div class="recommend-size" role="radiogroup" aria-label="Results per page">
          <span class="recommend-size-label">Show</span>
          ${sizeChips}
        </div>
      </div>
    ` : `<div class="meta" style="margin-bottom:6px"><strong>${Util.fmtNum(total)}</strong> recommended sub${total === 1 ? "" : "s"}</div>`;

    let pagerHtml = "";
    if (showControls && !isAll && totalPages > 1) {
      const start = safePage * pageSize + 1;
      const end = Math.min(total, (safePage + 1) * pageSize);
      pagerHtml = `
        <div class="recommend-pager">
          <button class="btn small" type="button" data-targeting-page="prev" data-targeting-surface="${Util.escapeHtml(surfaceKey)}" ${safePage === 0 ? "disabled" : ""}>« Prev</button>
          <span class="pagination-info">Page <strong>${safePage + 1}</strong> of ${totalPages} · ${start}–${end} of ${Util.fmtNum(total)}</span>
          <button class="btn small" type="button" data-targeting-page="next" data-targeting-surface="${Util.escapeHtml(surfaceKey)}" ${safePage >= totalPages - 1 ? "disabled" : ""}>Next »</button>
        </div>
      `;
    }

    el.innerHTML = head + sizeRow + cards + pagerHtml;
  };

  /* Render subreddit candidates from a Discovery.run result.
   *
   * Each candidate is a Discovery.scoreCandidate output:
   *   { key, name, record, score, signals:{…}, overlapTerms, reasons } */
  UI.renderDiscoveryCandidates = function (result, container, ctx) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) return;
    ctx = ctx || {};
    const candidates = (result && result.candidates) || [];
    const alreadyLoaded = (result && result.alreadyLoaded) || [];

    if (!candidates.length && !alreadyLoaded.length) {
      el.innerHTML = '<div class="empty">No candidate subreddits cleared the bar. Switch to <strong>All</strong> to see what was filtered out, or add more posts to the campaign so there is more vocabulary to match on.</div>';
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
      const s = c.signals || {};
      const record = c.record || {};
      const reasons = (c.reasons || []).map((r) => `<li>${r}</li>`).join("");
      const blurb = record.public_description || record.title || "";
      const desc = blurb ? `<div class="cand-desc">${Util.escapeHtml(blurb.slice(0, 220))}${blurb.length > 220 ? "…" : ""}</div>` : "";
      /* Theme and sphere are the two the score actually turns on, so they
       * lead; reach and activity are context for whether the match is
       * worth acting on. Which sphere the bar refers to is named in the
       * reasons directly below, so the label stays short here and keeps
       * the rows aligned. */
      const pct = (x) => Math.round((x || 0) * 100);
      const sphereTitle = s.sphereLabel
        ? `${pct(s.sphereFit)}% fit with the ${s.sphereLabel} sphere, weighted down to ${pct(s.sphere)}% because your campaign matches that sphere at ${pct(s.sphereConfidence)}%`
        : "No sphere matched";
      const meters = `
        <div class="meter-list">
          ${meterRow("Theme", s.theme, "var(--accent)", "Vocabulary overlap with your campaign's posts")}
          ${meterRow("Sphere", s.sphere, "var(--accent-2)", sphereTitle)}
          ${meterRow("Reach", s.popularity, "var(--info)", "Subscriber count, log-scaled")}
          ${meterRow("Activity", s.engagement, "var(--good)", "How much discussion a post here tends to get")}
        </div>
      `;
      const action = isAlready
        ? `<span class="badge info">already in your dashboard</span>`
        : `<button class="btn small primary" data-action="add" data-name="${Util.escapeHtml(c.key)}">＋ Add to dashboard</button>`;

      /* Submit-to-Reddit link (only when we have a campaign post template
       * AND the candidate sub doesn't already host it). The button is
       * paired with an inline "paste-back" input: after the user
       * submits on Reddit, they can paste the new post's URL right
       * here and we'll add it to the campaign so its stats start
       * tracking immediately. */
      let submitBlock = "";
      if (bestPost && !campaignSubs.has(c.key)) {
        const submitUrl = Util.buildSubmitUrl(c.key, bestPost);
        if (submitUrl) {
          const titleHint = String(bestPost.title || "").slice(0, 120);
          const tip = `Open Reddit's compose page in r/${c.key} pre-filled with "${titleHint}"${campaignName ? ` from "${campaignName}"` : ""}`;
          submitBlock = `
            <a class="btn small submit-link"
               data-action="open-submit"
               data-canonical="${Util.escapeHtml(c.key)}"
               href="${Util.escapeHtml(submitUrl)}"
               target="_blank" rel="noopener"
               title="${Util.escapeHtml(tip)}">↪ Cross-post here</a>`;
        }
      }

      /* The paste-back tracker is rendered for any candidate that has a
       * campaign context (the discover panel was opened for a campaign).
       * It's hidden by default; click on submit-link reveals it (also
       * see app.js delegated handler). The user can also click the
       * "I posted it" button manually if they already cross-posted in a
       * separate tab. */
      const trackerBlock = (campaignName && bestPost && !campaignSubs.has(c.key)) ? `
        <details class="cand-tracker" data-canonical="${Util.escapeHtml(c.key)}">
          <summary>↪ I posted to r/${Util.escapeHtml(c.key)} — track it in this campaign</summary>
          <div class="cand-tracker-body">
            <label class="group-label">Paste your new Reddit post URL — auto-adds on paste</label>
            <div class="cand-tracker-row">
              <input type="text"
                     data-action="track-post-url"
                     placeholder="https://www.reddit.com/r/${Util.escapeHtml(c.key)}/comments/..."
                     autocomplete="off"
                     spellcheck="false" />
              <button type="button" class="btn small ghost" data-action="track-post-paste" title="Pull a Reddit URL from your clipboard">📋 Paste</button>
              <button type="button" class="btn small primary" data-action="track-post-confirm">Add</button>
            </div>
            <div class="cand-tracker-status meta" hidden></div>
          </div>
        </details>
      ` : "";

      return `
        <div class="target-row candidate ${isAlready ? "already" : ""}" data-name="${Util.escapeHtml(c.key)}">
          <div class="target-head">
            <div>
              <span class="rank">#${i + 1}</span>
              <strong>r/${Util.escapeHtml(c.name)}</strong>
              <span class="badge ${cls}">fit ${c.score}</span>
            </div>
            <div class="target-meta">${Util.fmtNum(record.subscribers)} subs${record.active_user_count ? ` · ${Util.fmtNum(record.active_user_count)} online` : ""}</div>
          </div>
          ${desc}
          ${meters}
          <ul class="target-reasons">${reasons}</ul>
          <div class="cand-actions">
            ${action}
            ${submitBlock}
            <a class="btn small ghost" href="https://www.reddit.com/r/${Util.escapeHtml(c.key)}/" target="_blank" rel="noopener">Open in reddit ↗</a>
          </div>
          ${trackerBlock}
        </div>
      `;
    }

    /* Per-section pagination. New + already-loaded each get their
     * own page state (passed in via ctx.paging) so a user paging
     * through "New candidates" doesn't inadvertently reset their
     * scroll position in the "Already in your dashboard" section.
     * Falls back to "show first page of 25" when caller didn't
     * supply paging — preserves backward compatibility. */
    const pagingNew     = (ctx.paging && ctx.paging.new)     || { page: 0, pageSize: 25 };
    const pagingAlready = (ctx.paging && ctx.paging.already) || { page: 0, pageSize: 25 };

    function buildSection(items, surface, paging, opts) {
      const total = items.length;
      const pageSize = paging.pageSize || 25;
      const isAll = pageSize === "all";
      const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(paging.page || 0, totalPages - 1);
      const slice = isAll ? items : items.slice(safePage * pageSize, (safePage + 1) * pageSize);
      const showControls = total > 10;

      const sizeChips = showControls ? ["10", "25", "50", "100", "all"].map((sz) => {
        const isOn = String(pageSize) === sz;
        const label = sz === "all" ? "All" : sz;
        return `<button type="button" class="chip${isOn ? " active" : ""}" data-discover-size="${sz}" data-discover-surface="${surface}" role="radio" aria-checked="${isOn}">${label}</button>`;
      }).join("") : "";

      const sizeRow = showControls ? `
        <div class="recommend-controls">
          <span class="meta"><strong>${Util.fmtNum(total)}</strong> ${opts.totalLabel}</span>
          <div class="recommend-size" role="radiogroup" aria-label="Results per page">
            <span class="recommend-size-label">Show</span>
            ${sizeChips}
          </div>
        </div>
      ` : "";

      let pagerHtml = "";
      if (showControls && !isAll && totalPages > 1) {
        const start = safePage * pageSize + 1;
        const end = Math.min(total, (safePage + 1) * pageSize);
        pagerHtml = `
          <div class="recommend-pager">
            <button class="btn small" type="button" data-discover-page="prev" data-discover-surface="${surface}" ${safePage === 0 ? "disabled" : ""}>« Prev</button>
            <span class="pagination-info">Page <strong>${safePage + 1}</strong> of ${totalPages} · ${start}–${end} of ${Util.fmtNum(total)}</span>
            <button class="btn small" type="button" data-discover-page="next" data-discover-surface="${surface}" ${safePage >= totalPages - 1 ? "disabled" : ""}>Next »</button>
          </div>
        `;
      }

      const cards = slice.map((c, i) => renderCard(c, (isAll ? 0 : safePage * pageSize) + i, opts.isAlready)).join("");
      return { sizeRow, cards, pagerHtml };
    }

    const newSection = candidates.length
      ? (function () {
          const built = buildSection(candidates, "new", pagingNew, {
            totalLabel: "new candidate" + (candidates.length === 1 ? "" : "s"),
            isAlready: false,
          });
          return `<div class="discover-section">
             <h4 class="discover-h">New candidates (${candidates.length})</h4>
             ${built.sizeRow}
             ${built.cards}
             ${built.pagerHtml}
           </div>`;
        })()
      : `<div class="discover-section"><h4 class="discover-h">New candidates (0)</h4>
           <div class="empty">Every match is already in your dashboard. Scroll down to see how your existing subs scored, or load fewer subs and re-run Discover for fresh ideas.</div>
         </div>`;

    const alreadySection = alreadyLoaded.length
      ? (function () {
          const built = buildSection(alreadyLoaded, "already", pagingAlready, {
            totalLabel: "already in your dashboard",
            isAlready: true,
          });
          return `<div class="discover-section">
             <h4 class="discover-h">Already in your dashboard (${alreadyLoaded.length})</h4>
             <div class="discover-sub-hint">Confirms the engine ranked these high too — proof the discovery query is on-target.</div>
             ${built.sizeRow}
             ${built.cards}
             ${built.pagerHtml}
           </div>`;
        })()
      : "";

    el.innerHTML = newSection + alreadySection;
  };

  function meterRow(label, value, color, tip) {
    const pct = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
    const t = tip ? ` title="${Util.escapeHtml(tip)}"` : "";
    return `<div class="meter-row"${t}><span class="meter-label">${Util.escapeHtml(label)}</span><div class="meter-bar"><span style="width:${pct}%;background:${color}"></span></div><span class="meter-val">${pct}</span></div>`;
  }


  /* Tab switching used to live here. The shell now routes through
   * js/router.js, which owns view visibility, the topbar heading and the
   * hash, so UI no longer needs to know about panes at all. */

  function truncate(s, n) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  /* Pagination control: renders Prev / page-info / Next inside `container`.
   * Hidden when totalItems <= pageSize (or pageSize === "all"). Wires a
   * fresh el.onclick on every render so we don't leak listeners. */
  UI.renderPagination = function (container, opts) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) return;
    const page = Math.max(0, (opts && opts.page) || 0);
    const total = Math.max(0, (opts && opts.totalItems) || 0);
    const size = opts && opts.pageSize;
    const onChange = opts && typeof opts.onChange === "function" ? opts.onChange : function () {};

    if (size === "all" || size == null || total <= size) {
      el.hidden = true;
      el.innerHTML = "";
      el.onclick = null;
      return;
    }
    el.hidden = false;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const safePage = Math.min(page, totalPages - 1);
    const start = safePage * size + 1;
    const end = Math.min(total, (safePage + 1) * size);
    el.innerHTML = `
      <button class="btn small" type="button" data-page-action="prev" ${safePage === 0 ? "disabled" : ""} aria-label="Previous page">« Prev</button>
      <span class="pagination-info">Page <strong>${safePage + 1}</strong> of ${totalPages} · ${start}–${end} of ${Util.fmtNum(total)}</span>
      <button class="btn small" type="button" data-page-action="next" ${safePage >= totalPages - 1 ? "disabled" : ""} aria-label="Next page">Next »</button>
    `;
    el.onclick = function (e) {
      const btn = e.target && e.target.closest && e.target.closest("[data-page-action]");
      if (!btn || btn.disabled) return;
      e.preventDefault();
      const next = btn.dataset.pageAction === "next" ? safePage + 1 : safePage - 1;
      onChange(Math.max(0, Math.min(totalPages - 1, next)));
    };
  };

  window.UI = UI;
})();
