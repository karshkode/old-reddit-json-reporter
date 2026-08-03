/* ======================================================================
 * ANALYZE A POST
 * ----------------------------------------------------------------------
 * Paste a Reddit link, get back where else it belongs.
 *
 * The rest of the app works outward from communities: load some subs,
 * pull their posts, look for patterns. This works inward from a single
 * post, which is the question people actually arrive with — "I wrote
 * this, where should it go?" — and it needs no subreddits loaded at all.
 *
 * Four steps, each independently useful and each surviving the failure
 * of the ones after it:
 *
 *   1. Fetch the post. Title, body and flair, from the archive.
 *   2. Read it. Title AND body go into the term vector: a text post
 *      whose headline is "Thoughts?" is not a post about thoughts.
 *   3. Match it. The same discovery engine the campaign view uses,
 *      pointed at one post instead of a whole campaign.
 *   4. Find where it already is. Crossposts and same-link submissions,
 *      searched archive-wide, which are both a head start on a campaign
 *      and evidence about which communities take this kind of thing.
 *
 * The post lands in the posts inventory either way, so it is available
 * to every other view afterwards rather than only inside this dialog.
 * ====================================================================== */

(function () {
  "use strict";

  const Analyze = {};

  /* Populated by run(), read by the campaign and add buttons. */
  let current = null;
  let busy = false;

  /* ------------------------------------------------------------------
   * INPUT
   * ------------------------------------------------------------------ */

  /* What counts as "a Reddit post" in the box. Util.parsePostRefs
   * already knows every shape a post reference comes in — full links,
   * share links, old.reddit, redd.it, bare IDs — so the only judgement
   * here is whether the text is a reference at all. */
  Analyze.parse = function (text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const refs = Util.parsePostRefs(raw);
    if (refs.ids && refs.ids.length) return { id: refs.ids[0], share: null };
    if (refs.shares && refs.shares.length) return { id: null, share: refs.shares[0] };
    return null;
  };

  /* Whether a string is worth offering an "analyse this" action for.
   * Used by the search box, which must not offer it for every stray
   * word someone types. */
  Analyze.looksLikePost = function (text) {
    const t = String(text || "");
    if (!/reddit\.com|redd\.it/i.test(t)) return false;
    return !!Analyze.parse(t);
  };

  /* ------------------------------------------------------------------
   * THE RUN
   * ------------------------------------------------------------------ */

  /* opts.onStage(name, detail)  progress, so a slow archive is visibly
   *                             working rather than visibly hung. */
  Analyze.run = async function (text, opts) {
    opts = opts || {};
    const stage = (name, detail) => {
      if (typeof opts.onStage === "function") {
        try { opts.onStage(name, detail); } catch (_) {}
      }
    };

    const ref = Analyze.parse(text);
    if (!ref) throw new Error("That does not look like a link to a Reddit post. Paste the post's URL, or its ID.");

    let id = ref.id;
    if (!id && ref.share) {
      stage("fetch", "Following the share link…");
      id = await resolveShare(ref.share);
    }
    if (!id) throw new Error("Couldn't work out which post that link points at.");

    stage("fetch", "Reading the post…");
    const found = await Reddit.fetchPostsByIds([id]);
    const post = found && found[0];
    if (!post) throw new Error(`The archive has no post ${id}. Very new posts can take a few minutes to appear.`);
    post.imported = true;

    /* Into the inventory before anything else runs. Discovery and the
     * duplicate search can both fail; having fetched the post is
     * already worth keeping. */
    const added = Analyze.adopt(post);

    stage("match", "Working out what it is about…");
    const related = await Discovery.forPost(post, {
      limit: 12,
      live: !(window.Demo && Demo.isActive()),
    }).catch((err) => {
      console.warn("[analyze] discovery failed:", err && err.message);
      return null;
    });

    stage("duplicates", "Looking for it in other communities…");

    /* Three sources, deliberately independent. The archive's site-wide
     * search over crosspost_parent_id and url is the one with real
     * coverage, and the one that goes down; the other two need only
     * post lookups and the posts already on this machine, so the
     * feature degrades to "narrower" rather than to "broken". */
    const [remote, parent] = await Promise.all([
      Reddit.fetchDuplicates(post.id).then(
        (r) => ({ posts: [].concat(r.original ? [r.original] : [], r.duplicates || []) }),
        (err) => {
          console.warn("[analyze] duplicate search failed:", err && err.message);
          return { err: (err && err.message) || String(err) };
        }),
      fetchParent(post),
    ]);

    const elsewhere = Util.uniqBy(
      [].concat(remote.posts || [], parent, Analyze.findLocally(post))
        .filter((x) => x && x.id && x.id !== post.id),
      (x) => x.id
    );
    elsewhere.sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const p of elsewhere) p.imported = true;

    const dupeError = remote.err || null;

    current = {
      post: post,
      addedToInventory: added,
      related: related,
      elsewhere: Util.uniqBy(elsewhere, (p) => p.id),
      elsewhereError: dupeError,
      /* Communities this content is already in, so the recommendation
       * list can stop suggesting them. */
      takenSubs: new Set(elsewhere.concat([post]).map((p) => String(p.subreddit || "").toLowerCase())),
    };
    stage("done", "");
    return current;
  };

  /* The post this one was crossposted from, if it was. Costs one ID
   * lookup, which is a different archive endpoint from the search that
   * finds the siblings — so the original still turns up on days when
   * the search does not. */
  async function fetchParent(post) {
    const parentId = post.crosspost_parent_id;
    if (!parentId) return [];
    return Reddit.fetchPostsByIds([parentId]).catch((err) => {
      console.warn("[analyze] parent lookup failed:", err && err.message);
      return [];
    });
  }

  /* The same content among the posts already loaded on this machine.
   *
   * Free, offline, and for someone tracking 170 communities it covers
   * the subs they actually care about — which is where a crosspost
   * matters. It uses the same three tests the cross-post detector uses
   * on the dashboard, so a group found here is a group found there. */
  Analyze.findLocally = function (post) {
    const state = window.AppState;
    if (!state || !Array.isArray(state.posts)) return [];

    const parent = post.crosspost_parent_id || null;
    const self = "t3_" + post.id;
    const url = !post.is_self && (post.url_canonical || post.url) || null;
    const fp = Analysis.isPlaceholderTitle(post) ? "" : Analysis.titleFingerprint(post.title);

    const out = [];
    for (const other of state.posts) {
      if (!other || other.id === post.id) continue;
      const otherParent = other.crosspost_parent_id || null;
      const sameChain = (parent && otherParent === parent)
        || otherParent === self
        || (parent && "t3_" + other.id === parent);
      const sameLink = url && !other.is_self && (other.url_canonical || other.url) === url;
      const sameStory = fp && !Analysis.isPlaceholderTitle(other)
        && Analysis.titleFingerprint(other.title) === fp;
      if (sameChain || sameLink || sameStory) out.push(other);
    }
    return out;
  };

  /* Share links (reddit.com/r/sub/s/XXXX) do not contain the post ID —
   * they redirect to it. There is no way to follow a redirect and read
   * the destination from a static page without a proxy, so the archive
   * cannot resolve them either. Say so rather than failing vaguely. */
  async function resolveShare(share) {
    throw new Error(
      "Reddit share links (the /s/ ones) hide the post ID behind a redirect, which a page with no server cannot follow. " +
      "Open the link in a tab and copy the full URL from the address bar."
    );
  }

  /* Put a post into the inventory, in memory and on disk. Returns true
   * if it was not already there. */
  Analyze.adopt = function (post) {
    const state = window.AppState;
    if (!state) return false;
    const existing = state.posts.findIndex((p) => p.id === post.id);
    if (existing >= 0) {
      /* Keep the fresher copy but do not lose the imported mark, or the
       * next cache merge will treat it as ordinary listing fill and
       * drop it when its sub is unloaded. */
      post.imported = true;
      state.posts[existing] = post;
      return false;
    }
    state.posts.unshift(post);
    return true;
  };

  /* ------------------------------------------------------------------
   * CAMPAIGN
   * ------------------------------------------------------------------ */

  /* Everything found, as a campaign: the post, plus every other place
   * the same content is already posted. Those siblings are what makes
   * this worth doing automatically — the campaign opens with real
   * numbers in it instead of one post and a goal. */
  Analyze.campaignFrom = function (result, name) {
    if (!result || !result.post) throw new Error("Nothing analysed yet.");
    const posts = [result.post].concat(result.elsewhere || []);
    for (const p of posts) Analyze.adopt(p);

    const title = (result.post.title || "").trim();
    const campaign = Campaigns.add({
      name: name || (title ? title.slice(0, 60) : `r/${result.post.subreddit} post`),
      postIds: posts.map((p) => p.id).filter(Boolean),
    });
    return { campaign: campaign, posts: posts };
  };

  /* ------------------------------------------------------------------
   * VIEW
   * ------------------------------------------------------------------ */

  function el(id) { return document.getElementById(id); }
  const esc = (s) => Util.escapeHtml(String(s == null ? "" : s));

  function setStatus(html, kind) {
    const host = el("analyze-status");
    if (!host) return;
    host.className = "analyze-status" + (kind ? " is-" + kind : "");
    host.innerHTML = html || "";
  }

  function renderResult(result) {
    const host = el("analyze-result");
    if (!host) return;
    const p = result.post;

    const body = Util.postBody(p, 600);
    const read = [];
    read.push("title");
    if (body) read.push("body");
    if (p.flair) read.push("flair");

    const where = (result.elsewhere || []).slice();
    /* Reposts into the sub it is already in are worth listing but are
     * not another community, so they do not count towards the spread. */
    const home = String(p.subreddit || "").toLowerCase();
    const others = new Set(where.map((x) => String(x.subreddit || "").toLowerCase()));
    others.delete(home);
    const spread = others.size;

    host.innerHTML = `
      <div class="analyze-post">
        <div class="analyze-post-head">
          <a href="${esc(p.permalink)}" target="_blank" rel="noopener" class="analyze-post-title">${esc(p.title)}</a>
          ${p.title_source ? `<span class="badge warn" title="The archive holds a removal placeholder where this post's title should be. This is the ${p.title_source === "crosspost" ? "title of the post it was crossposted from" : "title of the page it links to"}.">title from the ${esc(p.title_source === "crosspost" ? "original" : "link")}</span>` : ""}
        </div>
        <div class="analyze-post-meta">
          r/${esc(p.subreddit)} · ${Util.fmtNum(p.score || 0)} pts · ${Util.fmtNum(p.num_comments || 0)} comments
          ${p.removed ? ' · <span class="tag flag-removed">removed</span>' : ""}
        </div>
        ${body ? `<p class="analyze-post-body">${esc(body.slice(0, 320))}${body.length > 320 ? "…" : ""}</p>` : ""}
        <p class="analyze-read">Matched on ${esc(read.join(", "))}${body ? "" : " — this post has no body text"}.</p>
      </div>

      <div class="analyze-block">
        <h3>Already posted in ${spread ? `${spread} other communit${spread === 1 ? "y" : "ies"}` : "no other community"}</h3>
        ${where.length ? `
          <ul class="analyze-elsewhere">
            ${where.slice(0, 8).map((x) => `
              <li>
                <a href="${esc(x.permalink)}" target="_blank" rel="noopener">r/${esc(x.subreddit)}</a>
                <span class="analyze-elsewhere-meta">▲ ${Util.fmtNum(x.score || 0)} · ${Util.fmtNum(x.num_comments || 0)} comments</span>
              </li>`).join("")}
          </ul>
          ${where.length > 8 ? `<p class="hint">and ${where.length - 8} more</p>` : ""}
          <p class="hint">These come into the campaign with the post, so its totals start from what the content has already earned.</p>
        ` : `<p class="hint">Nothing found in your loaded posts, and no crossposts of it. Everything below is a first move, not a repeat.</p>`}
        ${result.elsewhereError ? `
          <p class="hint">The archive's site-wide search is not answering right now, so this covers your own loaded posts and the post's own crosspost link only. There may be more elsewhere on Reddit.</p>
        ` : ""}
      </div>

      <div class="analyze-block">
        <h3>Where it could go next</h3>
        <div id="analyze-related"></div>
      </div>
    `;

    const relatedHost = el("analyze-related");
    if (relatedHost) {
      if (!result.related) {
        relatedHost.innerHTML = `<p class="hint">Couldn't reach the community index to match this post. The post is in your inventory — open it from Posts to try again.</p>`;
      } else {
        /* Suggesting a community the content is already in is not a
         * suggestion. Those are listed above instead. */
        const filtered = Object.assign({}, result.related, {
          communities: (result.related.communities || [])
            .filter((c) => !result.takenSubs.has(String(c.name || "").toLowerCase())),
        });
        UI.renderPostRelated(relatedHost, filtered, { actions: false, limit: 10 });
      }
    }

    const actions = el("analyze-actions");
    if (actions) actions.hidden = false;
    const campBtn = el("analyze-campaign-btn");
    if (campBtn) {
      campBtn.disabled = false;
      campBtn.textContent = where.length
        ? `+ Campaign from these ${where.length + 1} posts`
        : "+ Campaign from this post";
    }
  }

  async function submit() {
    if (busy) return;
    const input = el("analyze-input");
    if (!input) return;
    const text = input.value;

    const host = el("analyze-result");
    const actions = el("analyze-actions");
    if (host) host.innerHTML = "";
    if (actions) actions.hidden = true;
    current = null;

    if (!String(text || "").trim()) {
      setStatus("Paste the link to a Reddit post first.", "err");
      return;
    }

    busy = true;
    const go = el("analyze-go");
    if (go) { go.disabled = true; go.textContent = "Working…"; }
    setStatus("Reading the post…", "busy");

    try {
      const result = await Analyze.run(text, {
        onStage: (name, detail) => { if (detail) setStatus(esc(detail), "busy"); },
      });
      setStatus(result.addedToInventory
        ? "Added to your posts."
        : "Already in your posts — analysis refreshed.", "ok");
      renderResult(result);
      App.rerenderAll();
      App.updateRailCounts();
    } catch (err) {
      console.warn("[analyze]", err);
      setStatus(esc((err && err.message) || String(err)), "err");
    } finally {
      busy = false;
      if (go) { go.disabled = false; go.textContent = "Analyse"; }
    }
  }

  function makeCampaign() {
    if (!current) return;
    try {
      const { campaign, posts } = Analyze.campaignFrom(current);
      Analyze.close();
      Util.toast(`Created "${campaign.name}" with ${posts.length} post${posts.length === 1 ? "" : "s"}.`, "ok");
      App.populateCampaignSelectors();
      App.openCampaign(campaign);
    } catch (err) {
      Util.toast("Couldn't create the campaign: " + ((err && err.message) || err), "err");
    }
  }

  /* ------------------------------------------------------------------
   * DIALOG
   * ------------------------------------------------------------------ */

  Analyze.open = function (prefill) {
    const modal = el("analyze-modal");
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add("modal-open");
    const input = el("analyze-input");
    if (input) {
      if (prefill != null) input.value = String(prefill);
      try { input.focus({ preventScroll: true }); input.select(); } catch (_) {}
    }
    /* A link pasted somewhere else and sent here is a decision already
     * made; do not make them press the button again. */
    if (prefill && Analyze.parse(prefill)) submit();
  };

  Analyze.close = function () {
    const modal = el("analyze-modal");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove("modal-open");
  };

  Analyze.wire = function () {
    const modal = el("analyze-modal");
    if (!modal) return;

    modal.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest && t.closest('[data-action="close-analyze-modal"]')) {
        e.preventDefault();
        Analyze.close();
        return;
      }
      if (t.closest && t.closest("#analyze-go")) { e.preventDefault(); submit(); return; }
      if (t.closest && t.closest("#analyze-campaign-btn")) { e.preventDefault(); makeCampaign(); return; }
      const open = t.closest && t.closest('[data-action="analyze-open-post"]');
      if (open && current) {
        e.preventDefault();
        Analyze.close();
        App.openPostDetail(current.post);
      }
    });

    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); Analyze.close(); return; }
      if (e.key === "Enter" && e.target && e.target.id === "analyze-input") {
        e.preventDefault();
        submit();
      }
    });

    /* Every entry point into the dialog, from anywhere in the app. */
    document.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest('[data-action="open-analyze"]');
      if (!btn) return;
      e.preventDefault();
      Analyze.open(btn.getAttribute("data-prefill") || "");
    });
  };

  window.Analyze = Analyze;
})();
