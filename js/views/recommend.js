/* =====================================================================
 * RECOMMENDED POSTS — Plan hub inventory suggestions
 * ---------------------------------------------------------------------
 * Syndicate answers "where does this headline go?" for RSS. This card
 * answers the same question for posts already in the inventory, using
 * the same Discovery keyword / sphere match engine, and surfaces the
 * campaign CTA when copies already span multiple communities.
 *
 * Offline first (same pattern as Syndicate.suggestMany): paint from
 * cache, then batch-match in the background so Plan stays responsive.
 * Opening a row hands the post to Focus for the timed Next-move answer.
 * ===================================================================== */
(function () {
  "use strict";

  const View = {};
  const LIST_CAP = 16;
  const DEST_CAP = 3;
  const BATCH = 6;
  const CONCURRENCY = 2;

  let suggesting = false;
  let suggestTimer = 0;
  let audienceTimer = 0;
  let audienceBusy = false;
  const audienceAttempted = new Set();
  let dataSignature = "";
  let lastPainted = "";
  /* Shared with Syndicate articles on the Recommend pane. */
  let titleQuery = "";
  /* Post ids we already ran Discovery on for this inventory signature.
   * Weak matches (below the floor) used to stay in the work queue forever,
   * so paint → suggest → paint spun between "Matching… 9/16" and
   * "9 of 16 with strong destinations". */
  const attempted = new Set();

  const esc = (s) => Util.escapeHtml(s == null ? "" : String(s));

  function trunc(s, n) {
    const t = String(s == null ? "" : s);
    return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
  }

  function host() {
    return Dom.byId("plan-recommend-body");
  }

  function floor() {
    return (window.Discovery && Discovery.MIN_SUGGEST_SCORE != null)
      ? Discovery.MIN_SUGGEST_SCORE
      : 35;
  }

  function resetAttemptsIfScopeChanged(signature) {
    if (!signature || signature === dataSignature) return;
    dataSignature = signature;
    attempted.clear();
    audienceAttempted.clear();
  }

  /* Still needs an offline Discovery pass. Cached (even weak) or already
   * attempted rows are settled until the user taps Re-rank. */
  function needsMatch(post, force) {
    if (!post || !post.id) return false;
    if (force) return true;
    if (cachedMatch(post)) return false;
    if (attempted.has(post.id)) return false;
    return true;
  }

  View.titleQuery = function () {
    return String(titleQuery || "").trim().toLowerCase();
  };

  /* One representative per url / title cluster so a 12-sub cross-post
   * group does not fill the list with clones. Prefer the highest score.
   * Title filter runs before the cap so a search can surface matches
   * outside the default top-N ranking window. */
  function candidatePosts(limit) {
    const posts = ((window.AppState && AppState.posts) || []).filter((p) => {
      if (!p || !p.id || p.syndicated) return false;
      if (!p.title && !p.url) return false;
      return true;
    });
    const byKey = new Map();
    for (const p of posts) {
      const url = String(p.url || "").trim().toLowerCase();
      const title = String(p.title || "").trim().toLowerCase();
      const key = url || ("t:" + title);
      if (!key || key === "t:") continue;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, p);
        continue;
      }
      const prefer =
        (!!p.imported && !prev.imported) ||
        ((p.score || 0) > (prev.score || 0)) ||
        ((p.num_comments || 0) > (prev.num_comments || 0) && (p.score || 0) === (prev.score || 0));
      if (prefer) byKey.set(key, p);
    }
    let list = Array.from(byKey.values())
      .sort((a, b) => {
        const ai = a.imported ? 1 : 0;
        const bi = b.imported ? 1 : 0;
        if (bi !== ai) return bi - ai;
        return (b.score || 0) - (a.score || 0) || (b.created_utc || 0) - (a.created_utc || 0);
      });
    const q = View.titleQuery();
    if (q) {
      list = list.filter((p) => String(p.title || "").toLowerCase().indexOf(q) !== -1);
    }
    return list.slice(0, limit == null ? LIST_CAP : limit);
  }

  function inventoryHasPosts() {
    return ((window.AppState && AppState.posts) || []).some((p) => {
      if (!p || !p.id || p.syndicated) return false;
      return !!(p.title || p.url);
    });
  }

  function cachedMatch(post) {
    if (!post || !window.AppState) return null;
    return AppState.postRelated.get(post.id) || null;
  }

  function suggestionsOf(result, limit, home) {
    if (!result) return [];
    const min = floor();
    const homeKey = String(home || "").toLowerCase();
    const list = (result.communities || result.candidates || []).filter((c) => {
      if (!c) return false;
      const name = String(c.name || c.key || "").toLowerCase();
      if (homeKey && name === homeKey) return false;
      const score = c.score == null ? 0 : Number(c.score);
      return score >= min;
    });
    list.sort((a, b) => (b.score || 0) - (a.score || 0));
    return list.slice(0, limit == null ? DEST_CAP : limit);
  }

  function topScore(result, home) {
    const tips = suggestionsOf(result, 1, home);
    return tips.length ? (tips[0].score || 0) : -1;
  }

  function keywordsOf(post, result, limit) {
    if (result && Array.isArray(result.terms) && result.terms.length) {
      return result.terms.slice(0, limit || 6).map((t) =>
        typeof t === "string" ? t : (t.term || "")
      ).filter(Boolean);
    }
    if (window.Discovery && Discovery.topTerms && Discovery.postVector) {
      try {
        const vec = Discovery.postVector(post);
        return Discovery.topTerms(vec, limit || 6).map((t) => t.term || t).filter(Boolean);
      } catch (_) {}
    }
    return [];
  }

  async function matchOne(post, opts) {
    opts = opts || {};
    if (!post || !window.Discovery) return null;
    const hit = cachedMatch(post);
    if (hit && !opts.force) {
      attempted.add(post.id);
      return hit;
    }
    const include = (window.AppState && AppState.knownSubs)
      ? AppState.knownSubs.slice()
      : [];
    try {
      const result = await Discovery.forPost(post, {
        limit: opts.limit || 8,
        live: opts.live === true,
        aboutBudget: opts.aboutBudget == null ? 0 : opts.aboutBudget,
        linkPriors: opts.linkPriors === true,
        /* Prefer desk keyword Reddit search when local matches are scarce. */
        keywordSearchIfBelow: opts.keywordSearchIfBelow != null ? opts.keywordSearchIfBelow : 4,
        searchQueryLimit: opts.searchQueryLimit || 2,
        include: include,
        onPartial: (partial) => {
          if (window.AppState) AppState.postRelated.set(post.id, partial);
          if (typeof opts.onPartial === "function") opts.onPartial(partial);
        },
      });
      if (window.AppState) AppState.postRelated.set(post.id, result);
      return result;
    } finally {
      attempted.add(post.id);
    }
  }

  function destHtml(tips, home) {
    const homeKey = String(home || "").toLowerCase();
    if (!tips.length) {
      return `<div class="plan-rec-dests" data-plan-rec-dests><span class="plan-rec-nodest meta">No strong destination yet</span></div>`;
    }
    /* Compact chip row — name + score only. Matching keywords live on
     * the post (title/body) and on the audience strip (comments), not
     * repeated under every destination. */
    return `<div class="plan-rec-dests" data-plan-rec-dests role="list" aria-label="Suggested destinations">
      <span class="plan-rec-dests-label">Next</span>
      ${tips.map((c, i) => {
        const name = c.name || c.key;
        const same = String(name || "").toLowerCase() === homeKey;
        const score = c.score == null ? "" : Math.round(c.score);
        const title = same
          ? `Already in r/${name}`
          : (c.overlapTerms && c.overlapTerms.length
            ? `Match ${score} · ${(c.overlapTerms || []).slice(0, 3).map((t) => typeof t === "string" ? t : (t.term || "")).filter(Boolean).join(", ")}`
            : `Match ${score}`);
        return `<span class="plan-rec-dest-chip${i === 0 && !same ? " is-top" : ""}${same ? " is-posted" : ""}" role="listitem" title="${esc(title)}">
          <span class="plan-rec-dest-name">r/${esc(name)}</span>
          ${same
            ? `<span class="plan-rec-dest-score is-here">here</span>`
            : (score !== "" ? `<span class="plan-rec-dest-score">${esc(String(score))}</span>` : "")}
        </span>`;
      }).join("")}
    </div>`;
  }

  function audienceOf(post) {
    if (!post || !window.AppState || !AppState.audienceByPost) return null;
    return AppState.audienceByPost.get(post.id) || null;
  }

  function audienceHtml(post) {
    const aud = audienceOf(post);
    const n = post && (post.num_comments || 0);
    if (!aud || !aud.total) {
      if (n > 0) {
        return `<div class="plan-rec-audience is-pending" data-plan-rec-aud>
          <span class="meta">Audience · ${Util.fmtNum(n)} comments — reading tone…</span>
        </div>`;
      }
      return `<div class="plan-rec-audience is-empty" data-plan-rec-aud hidden></div>`;
    }
    const cls = aud.label === "supportive" ? "good"
      : aud.label === "hostile" ? "bad"
      : aud.label === "mixed" ? "warn" : "info";
    const keys = (aud.keywords || []).slice(0, 4).map((k) =>
      typeof k === "string" ? k : (k.word || "")
    ).filter(Boolean);
    return `<div class="plan-rec-audience" data-plan-rec-aud>
      <span class="badge ${cls}" title="Comment-thread tone in r/${esc(post.subreddit || "?")}">${esc(aud.label)}</span>
      <span class="meta">audience · ${Util.fmtNum(aud.total)} comments</span>
      ${keys.length ? `<span class="plan-rec-aud-keys" title="What commenters talked about">${keys.map((k) => `<code>${esc(k)}</code>`).join(" ")}</span>` : ""}
    </div>`;
  }

  function campaignActions(post) {
    if (!window.Crosspost) return "";
    const campaign = Crosspost.campaignFor && Crosspost.campaignFor(post);
    if (campaign) {
      return `<button type="button" class="btn small" data-action="plan-rec-open-campaign" data-campaign="${esc(campaign.id)}"
                title="Open the campaign tracking these copies">Tracking · ${esc(trunc(campaign.name, 28))}</button>`;
    }
    const spread = Crosspost.subsWithCopies ? Crosspost.subsWithCopies(post).size : 0;
    if (spread >= 2) {
      return `<button type="button" class="btn small primary" data-action="plan-rec-make-campaign" data-post="${esc(post.id)}"
                title="Turn these ${spread} community copies into a campaign">+ Make campaign · ${spread} subs</button>`;
    }
    return "";
  }

  function rowHtml(post, result) {
    const tips = suggestionsOf(result, DEST_CAP, post.subreddit);
    const keys = keywordsOf(post, result, 4);
    const when = post.created_utc ? Util.relTime(post.created_utc) : "";
    const camp = campaignActions(post);
    const top = tips.length && String(tips[0].name || "").toLowerCase() !== String(post.subreddit || "").toLowerCase()
      ? tips[0]
      : null;
    const topBit = top && top.score != null
      ? `<span class="plan-rec-top-fit meta" title="Best destination match">→ r/${esc(top.name || top.key)} ${Math.round(top.score)}</span>`
      : "";
    return `
      <article class="plan-rec-row" data-plan-rec-id="${esc(post.id)}">
        <div class="plan-rec-main">
          <div class="plan-syn-kicker">
            <span class="syn-source-box">r/${esc(post.subreddit || "?")}</span>
            <span class="meta">${Util.fmtNum(post.score || 0)} pts${when ? " · " + esc(when) : ""}${post.num_comments ? " · " + Util.fmtNum(post.num_comments) + " cmt" : ""}${post.imported ? " · just added" : ""}</span>
            ${topBit}
          </div>
          <h3 class="plan-rec-title">${esc(trunc(post.title || "(untitled)", 140))}</h3>
          ${keys.length ? `<div class="plan-syn-keys plan-rec-post-keys" title="From title and body">${keys.map((k) => `<code>${esc(k)}</code>`).join(" ")}</div>` : ""}
          ${audienceHtml(post)}
          ${destHtml(tips, post.subreddit)}
          <div class="plan-syn-actions">
            <button type="button" class="btn primary small" data-action="plan-rec-open" data-post="${esc(post.id)}">Open in Plan</button>
            <button type="button" class="btn small" data-action="plan-rec-view" data-post="${esc(post.id)}"
                    title="Read this post in the in-app feed">View</button>
            <span data-plan-rec-camp>${camp}</span>
            ${post.permalink ? `<a class="btn ghost small" href="${esc(post.permalink)}" target="_blank" rel="noopener">Reddit ↗</a>` : ""}
          </div>
        </div>
      </article>`;
  }

  function rankedForPaint(posts) {
    return posts.slice().sort((a, b) => {
      const sa = topScore(cachedMatch(a), a.subreddit);
      const sb = topScore(cachedMatch(b), b.subreddit);
      if (sb !== sa) return sb - sa;
      return (b.score || 0) - (a.score || 0);
    });
  }

  View.paint = function (signature, opts) {
    opts = opts || {};
    const el = host();
    if (!el) return;
    if (signature) resetAttemptsIfScopeChanged(signature);

    const q = View.titleQuery();
    const posts = candidatePosts(LIST_CAP);
    if (!posts.length) {
      if (q && inventoryHasPosts()) {
        el.innerHTML = `<div class="empty plan-syn-empty">
          <strong>No title matches</strong>
          <p>Nothing in loaded posts matches “${esc(q)}”.</p>
        </div>`;
        lastPainted = "filter-empty:" + q;
      } else {
        el.innerHTML = `<div class="empty plan-syn-empty">
          <strong>No loaded posts yet</strong>
          <p>Sync communities above, then this list ranks where each post fits next — same match engine as Syndicate.</p>
        </div>`;
        lastPainted = "empty";
      }
      return;
    }

    const ranked = rankedForPaint(posts);
    const matched = ranked.filter((p) => suggestionsOf(cachedMatch(p), 1, p.subreddit).length).length;
    const pending = ranked.filter((p) => needsMatch(p, false)).length;
    const settled = ranked.length - pending;
    let status;
    if (suggesting) {
      status = `Matching destinations… ${settled}/${ranked.length}`;
    } else if (pending) {
      status = matched
        ? `${matched} strong so far · ranking ${pending} more…`
        : `Ranking ${ranked.length} posts for destinations…`;
    } else if (matched) {
      status = matched === ranked.length
        ? `${matched} posts with strong destinations`
        : `${matched} of ${ranked.length} with strong destinations`;
    } else {
      status = `No strong destinations in ${ranked.length} posts — try Re-rank after loading more communities`;
    }
    if (q) status = `Title “${q}” · ${status}`;

    const structureSig = q + ":" + ranked.map((p) => p.id).join(",");
    const paintSig = structureSig + ":" + matched + ":" + pending + ":" + (suggesting ? 1 : 0);
    const listEl = el.querySelector(".plan-rec-list");
    const metaEl = el.querySelector(".plan-rec-meta");

    /* Mid-suggest paints used to rewrite every row (and every button) on
     * every partial — a tap on Open in Plan often landed on a node that
     * had just been destroyed. Keep the row DOM when the post set is
     * unchanged; only refresh status + destination chips. */
    if (listEl && metaEl && lastPainted && lastPainted.startsWith(structureSig + ":")) {
      metaEl.textContent = status;
      for (const post of ranked) {
        const row = listEl.querySelector(`[data-plan-rec-id="${CSS.escape(post.id)}"]`);
        if (!row) continue;
        const destSlot = row.querySelector("[data-plan-rec-dests]");
        if (destSlot) destSlot.outerHTML = destHtml(suggestionsOf(cachedMatch(post), DEST_CAP, post.subreddit), post.subreddit);
        const audSlot = row.querySelector("[data-plan-rec-aud]");
        if (audSlot) audSlot.outerHTML = audienceHtml(post);
        const campSlot = row.querySelector("[data-plan-rec-camp]");
        if (campSlot) campSlot.innerHTML = campaignActions(post);
      }
      lastPainted = paintSig;
      if (!opts.skipSchedule && pending && !suggesting) View.scheduleSuggest();
      if (!opts.skipAudience) View.scheduleAudience(ranked);
      return;
    }

    el.innerHTML = `
      <div class="plan-rec-meta meta">${esc(status)}</div>
      <div class="plan-rec-list">
        ${ranked.map((p) => rowHtml(p, cachedMatch(p))).join("")}
      </div>`;
    lastPainted = paintSig;

    /* Only kick the worker when there is unmatched work — paint during
     * an in-flight suggest must not queue another pass. */
    if (!opts.skipSchedule && pending && !suggesting) {
      View.scheduleSuggest();
    }
    if (!opts.skipAudience) View.scheduleAudience(ranked);
  };

  View.scheduleSuggest = function (opts) {
    opts = opts || {};
    if (suggesting) return;
    if (suggestTimer) {
      window.clearTimeout(suggestTimer);
      suggestTimer = 0;
    }
    const delay = opts.delay == null ? 60 : opts.delay;
    suggestTimer = window.setTimeout(() => {
      suggestTimer = 0;
      View.suggest(opts).catch(() => {});
    }, delay);
  };

  /* Pull a small comment sample for visible Recommend rows so each card
   * can show reception tone + audience keywords without opening detail.
   * Budgeted: one at a time, few per pass, skip posts with no comments. */
  View.scheduleAudience = function (posts) {
    if (audienceBusy) return;
    if (audienceTimer) {
      window.clearTimeout(audienceTimer);
      audienceTimer = 0;
    }
    audienceTimer = window.setTimeout(() => {
      audienceTimer = 0;
      View.enrichAudience(posts).catch(() => {});
    }, 400);
  };

  View.enrichAudience = async function (posts) {
    if (audienceBusy || !window.Reddit || !Reddit.fetchPostWithComments) return;
    if (!window.Analysis || !Analysis.summarizeAudience) return;
    if (!window.AppState) return;
    const list = (posts || []).filter((p) => {
      if (!p || !p.id) return false;
      if (AppState.audienceByPost.has(p.id)) return false;
      if (audienceAttempted.has(p.id)) return false;
      return (p.num_comments || 0) > 0;
    }).slice(0, 5);
    if (!list.length) return;
    audienceBusy = true;
    try {
      for (const post of list) {
        audienceAttempted.add(post.id);
        try {
          let data = AppState.detailCache && AppState.detailCache.get(post.id);
          if (!data) {
            data = await Reddit.fetchPostWithComments(post.id, { commentLimit: 40 });
            if (data && AppState.detailCache) AppState.detailCache.set(post.id, data);
          }
          if (!data || !data.comments) continue;
          const summary = Analysis.summarizeAudience(data.comments);
          AppState.audienceByPost.set(post.id, summary);
          /* Soft re-paint so destination matching can pick up audience
           * keywords without resetting button DOM mid-tap. */
          View.paint(dataSignature, { skipSchedule: true, skipAudience: true });
        } catch (_) {
          /* Leave the pending strip; a later Re-rank / View can retry. */
        }
      }
    } finally {
      audienceBusy = false;
    }
  };

  View.suggest = async function (opts) {
    opts = opts || {};
    if (suggesting) return { busy: true };
    if (!window.Discovery) return { done: 0 };
    const force = !!opts.force;
    if (force) attempted.clear();

    const posts = candidatePosts(LIST_CAP);
    const want = posts.filter((p) => needsMatch(p, force)).slice(0, opts.limit || LIST_CAP);
    if (!want.length) {
      View.paint(dataSignature, { skipSchedule: true });
      return { done: 0, total: 0 };
    }

    suggesting = true;
    View.paint(dataSignature, { skipSchedule: true });
    let done = 0;
    try {
      /* Waves keep the Recommend tab interactive — same idea as Syndicate. */
      for (let i = 0; i < want.length; i += BATCH) {
        const batch = want.slice(i, i + BATCH);
        await Util.pmap(batch, CONCURRENCY, async (post) => {
          try {
            await matchOne(post, {
              live: false,
              aboutBudget: 0,
              force: force,
              onPartial: () => {
                if (window.Router && Router.current() === "dashboard" && AppState.dashSection === "recommend") {
                  View.paint(dataSignature, { skipSchedule: true });
                }
              },
            });
          } catch (_) {
            attempted.add(post.id);
          }
          done++;
        });
        if (window.Router && Router.current() === "dashboard" && AppState.dashSection === "recommend") {
          View.paint(dataSignature, { skipSchedule: true });
        }
        await new Promise((r) => setTimeout(r, 16));
      }
      return { done: done, total: want.length };
    } finally {
      suggesting = false;
      View.paint(dataSignature, { skipSchedule: true });
    }
  };

  View.candidatePosts = candidatePosts;

  View.openInPlan = function (postId) {
    const post = ((window.AppState && AppState.posts) || []).find((p) => p && p.id === postId);
    if (!post || !window.FocusView) return;
    const related = cachedMatch(post);
    FocusView.focusPost(post, related ? { related: related } : undefined);
  };

  View.makeCampaign = function (postId) {
    const post = ((window.AppState && AppState.posts) || []).find((p) => p && p.id === postId);
    if (!post || !window.Crosspost) return;
    try {
      const made = Crosspost.track(post);
      Util.toast(`Tracking ${made.posts.length} posts as "${made.campaign.name}".`, "ok");
      if (window.App) {
        App.populateCampaignSelectors();
        App.publishCampaign(made.campaign);
      }
      View.paint(dataSignature, { skipSchedule: true });
    } catch (err) {
      Util.toast("Couldn't make a campaign: " + ((err && err.message) || err), "err");
    }
  };

  function refreshTitleFilter() {
    lastPainted = "";
    View.paint(dataSignature, { skipSchedule: true });
    if (window.SyndicateView && SyndicateView.paintPlanCarousel) {
      try { SyndicateView.paintPlanCarousel(); } catch (_) {}
    }
  }

  View.bind = function () {
    Dom.delegate(document, "click", '[data-action="plan-rec-open"]', (e, el) => {
      if (el.dataset.post) View.openInPlan(el.dataset.post);
    });
    Dom.delegate(document, "click", '[data-action="plan-rec-view"]', (e, el) => {
      const id = el.dataset.post;
      const post = ((window.AppState && AppState.posts) || []).find((p) => p && p.id === id);
      if (!post || !window.FeedView) return;
      FeedView.openPost(post, {
        posts: candidatePosts(24),
        title: "Recommended posts",
        subtitle: trunc(post.title || "", 60),
      });
    });
    Dom.delegate(document, "click", '[data-action="plan-rec-make-campaign"]', (e, el) => {
      if (el.dataset.post) View.makeCampaign(el.dataset.post);
    });
    Dom.delegate(document, "click", '[data-action="plan-rec-open-campaign"]', (e, el) => {
      if (el.dataset.campaign && window.App) App.openCampaign(el.dataset.campaign);
    });
    Dom.delegate(document, "click", '[data-action="plan-rec-refresh"]', () => {
      attempted.clear();
      View.suggest({ force: true, limit: LIST_CAP }).catch(() => {});
    });
    const search = Dom.byId("recommend-title-search");
    if (search && !search.dataset.boundTitleFilter) {
      search.dataset.boundTitleFilter = "1";
      if (search.value !== titleQuery) search.value = titleQuery;
      search.addEventListener("input", () => {
        titleQuery = search.value || "";
        refreshTitleFilter();
      });
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => View.bind());
  } else {
    View.bind();
  }

  window.RecommendView = View;
})();
