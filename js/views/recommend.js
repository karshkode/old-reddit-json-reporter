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
  let dataSignature = "";
  let lastPainted = "";

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

  /* One representative per url / title cluster so a 12-sub cross-post
   * group does not fill the list with clones. Prefer the highest score. */
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
    return Array.from(byKey.values())
      .sort((a, b) => {
        const ai = a.imported ? 1 : 0;
        const bi = b.imported ? 1 : 0;
        if (bi !== ai) return bi - ai;
        return (b.score || 0) - (a.score || 0) || (b.created_utc || 0) - (a.created_utc || 0);
      })
      .slice(0, limit == null ? LIST_CAP : limit);
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
    if (hit && !opts.force) return hit;
    const include = (window.AppState && AppState.knownSubs)
      ? AppState.knownSubs.slice()
      : [];
    const result = await Discovery.forPost(post, {
      limit: opts.limit || 8,
      live: opts.live === true,
      aboutBudget: opts.aboutBudget == null ? 0 : opts.aboutBudget,
      linkPriors: opts.linkPriors === true,
      include: include,
      onPartial: (partial) => {
        if (window.AppState) AppState.postRelated.set(post.id, partial);
        if (typeof opts.onPartial === "function") opts.onPartial(partial);
      },
    });
    if (window.AppState) AppState.postRelated.set(post.id, result);
    return result;
  }

  function destHtml(tips, home) {
    const homeKey = String(home || "").toLowerCase();
    if (!tips.length) {
      return `<p class="plan-rec-nodest meta">No strong destination yet — matching in the background.</p>`;
    }
    return `<div class="plan-syn-dests">${tips.map((c, i) => {
      const name = c.name || c.key;
      const same = String(name || "").toLowerCase() === homeKey;
      const score = c.score == null ? "" : Math.round(c.score);
      const terms = (c.overlapTerms || []).slice(0, 3).map((t) =>
        typeof t === "string" ? t : (t.term || "")
      ).filter(Boolean);
      return `<div class="plan-syn-dest${i === 0 && !same ? " is-top" : ""}${same ? " is-posted" : ""}"${same ? ` title="Already in r/${esc(name)}"` : ""}>
        <span class="plan-syn-dest-name">r/${esc(name)}</span>
        ${same
          ? `<span class="badge bad">already here</span>`
          : (score !== "" ? `<span class="badge accent">${esc(String(score))}</span>` : "")}
        ${terms.length ? `<span class="plan-syn-dest-terms">${terms.map((t) => `<code>${esc(t)}</code>`).join(" ")}</span>` : ""}
      </div>`;
    }).join("")}</div>`;
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
    const keys = keywordsOf(post, result, 6);
    const when = post.created_utc ? Util.relTime(post.created_utc) : "";
    const camp = campaignActions(post);
    return `
      <article class="plan-rec-row" data-plan-rec-id="${esc(post.id)}">
        <div class="plan-rec-main">
          <div class="plan-syn-kicker">
            <span class="syn-source-box">r/${esc(post.subreddit || "?")}</span>
            <span class="meta">${Util.fmtNum(post.score || 0)} pts${when ? " · " + esc(when) : ""}${post.imported ? " · just added" : ""}</span>
          </div>
          <h3 class="plan-rec-title">${esc(trunc(post.title || "(untitled)", 120))}</h3>
          ${keys.length ? `<div class="plan-syn-keys">${keys.map((k) => `<code>${esc(k)}</code>`).join(" ")}</div>` : ""}
          ${destHtml(tips, post.subreddit)}
          <div class="plan-syn-actions">
            <button type="button" class="btn primary small" data-action="plan-rec-open" data-post="${esc(post.id)}">Open in Plan</button>
            ${camp}
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

  View.paint = function (signature) {
    const el = host();
    if (!el) return;
    if (signature) dataSignature = signature;

    const posts = candidatePosts(LIST_CAP);
    if (!posts.length) {
      el.innerHTML = `<div class="empty plan-syn-empty">
        <strong>No loaded posts yet</strong>
        <p>Sync communities above, then this list ranks where each post fits next — same match engine as Syndicate.</p>
      </div>`;
      lastPainted = "empty";
      return;
    }

    const ranked = rankedForPaint(posts);
    const matched = ranked.filter((p) => suggestionsOf(cachedMatch(p), 1, p.subreddit).length).length;
    const status = suggesting
      ? `Matching destinations… ${matched}/${ranked.length}`
      : matched
        ? `${matched} of ${ranked.length} with strong destinations`
        : `Ranking ${ranked.length} posts for destinations…`;

    el.innerHTML = `
      <div class="plan-rec-meta meta">${esc(status)}</div>
      <div class="plan-rec-list">
        ${ranked.map((p) => rowHtml(p, cachedMatch(p))).join("")}
      </div>`;
    lastPainted = ranked.map((p) => p.id).join(",") + ":" + matched + ":" + (suggesting ? 1 : 0);

    View.scheduleSuggest();
  };

  View.scheduleSuggest = function (opts) {
    opts = opts || {};
    if (suggesting) return;
    const delay = opts.delay == null ? 60 : opts.delay;
    window.setTimeout(() => {
      View.suggest(opts).catch(() => {});
    }, delay);
  };

  View.suggest = async function (opts) {
    opts = opts || {};
    if (suggesting) return { busy: true };
    if (!window.Discovery) return { done: 0 };
    const posts = candidatePosts(LIST_CAP);
    const want = posts.filter((p) => {
      if (opts.force) return true;
      const hit = cachedMatch(p);
      if (!hit) return true;
      return !suggestionsOf(hit, 1, p.subreddit).length;
    }).slice(0, opts.limit || BATCH * 2);
    if (!want.length) {
      if (lastPainted) View.paint(dataSignature);
      return { done: 0, total: 0 };
    }

    suggesting = true;
    View.paint(dataSignature);
    let done = 0;
    try {
      /* Waves keep the Plan tab interactive — same idea as Syndicate. */
      for (let i = 0; i < want.length; i += BATCH) {
        const batch = want.slice(i, i + BATCH);
        await Util.pmap(batch, CONCURRENCY, async (post) => {
          try {
            await matchOne(post, {
              live: false,
              aboutBudget: 0,
              force: !!opts.force,
              onPartial: () => {
                /* Cheap partial paints only while still on Plan. */
                if (window.Router && Router.current() === "dashboard" && AppState.dashSection === "plan") {
                  View.paint(dataSignature);
                }
              },
            });
          } catch (_) {}
          done++;
        });
        if (window.Router && Router.current() === "dashboard" && AppState.dashSection === "plan") {
          View.paint(dataSignature);
        }
        await new Promise((r) => setTimeout(r, 16));
      }
      return { done: done, total: want.length };
    } finally {
      suggesting = false;
      View.paint(dataSignature);
    }
  };

  View.openInPlan = function (postId) {
    const post = ((window.AppState && AppState.posts) || []).find((p) => p && p.id === postId);
    if (!post || !window.FocusView) return;
    const related = cachedMatch(post);
    FocusView.focusPost(post, related ? { related: related } : undefined);
    const card = Dom.byId("focus-card");
    if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
      View.paint(dataSignature);
    } catch (err) {
      Util.toast("Couldn't make a campaign: " + ((err && err.message) || err), "err");
    }
  };

  View.bind = function () {
    Dom.delegate(document, "click", '[data-action="plan-rec-open"]', (e, el) => {
      if (el.dataset.post) View.openInPlan(el.dataset.post);
    });
    Dom.delegate(document, "click", '[data-action="plan-rec-make-campaign"]', (e, el) => {
      if (el.dataset.post) View.makeCampaign(el.dataset.post);
    });
    Dom.delegate(document, "click", '[data-action="plan-rec-open-campaign"]', (e, el) => {
      if (el.dataset.campaign && window.App) App.openCampaign(el.dataset.campaign);
    });
    Dom.delegate(document, "click", '[data-action="plan-rec-refresh"]', () => {
      View.suggest({ force: true, limit: LIST_CAP }).catch(() => {});
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => View.bind());
  } else {
    View.bind();
  }

  window.RecommendView = View;
})();
