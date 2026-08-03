/* ======================================================================
 * CROSS-POSTING — where a post actually is, and what is tracking it
 * ----------------------------------------------------------------------
 * The placement card ranks communities for one post. Acting on that
 * ranking means putting the post in one of them, and until now the only
 * button on offer was "make a campaign", which is a filing cabinet, not
 * an action. Worse, it sent people into the campaign workspace, where a
 * different engine answers a different question and recommends a
 * different set of communities.
 *
 * This module holds the small amount of state that turns a ranking into
 * a workflow:
 *
 *   copiesOf(post)        every place this content already is
 *   campaignFor(post)     the campaign tracking it, if one exists
 *   syncCampaign(post)    fold newly-found copies into that campaign
 *   markOpened / pending  which submit pages have been opened and not
 *                         yet accounted for
 *
 * The rule about campaigns is deliberate: one is only worth existing
 * once the content is in more than one place. A campaign holding a
 * single post has nothing to compare, nothing to total, and no reason
 * to be a separate screen. So nothing here creates one speculatively
 * from a recommendation — a recommendation is a place you might post,
 * and a campaign is a record of where you did.
 *
 * "Opened" intents are the bridge between those two states. Clicking a
 * cross-post link is the last thing this page sees; whether a post
 * followed happens on Reddit. So the intent is remembered, and the copy
 * is picked up either by pasting the link back or by the next sync of
 * that community finding it. Both paths end in the same place.
 * ====================================================================== */

(function () {
  "use strict";

  const Crosspost = {};
  const KEY = "rj.crosspostOpened";
  const LINK_KEY = "rj.crosspostLinks";

  /* postId -> { subLower: openedAtMs }. Small, and worth surviving a
     reload: the whole point is that the user left for another tab. */
  let opened = read(KEY);

  /* postId -> [postId]. Copies the user has told us about, symmetric.
     The detector matches on crosspost chains, shared links and title
     fingerprints, all of which a reworded headline defeats — and
     rewording for a new community is normal practice, not an edge case.
     Someone saying "this is the same post" is better evidence than a
     fingerprint, so it is kept, and kept out of the post objects: those
     are rebuilt field by field from the adapter on every sync, and
     anything written onto them locally is gone by the next fetch. */
  let links = read(LINK_KEY);

  function read(key) {
    try {
      const raw = JSON.parse(localStorage.getItem(key));
      return raw && typeof raw === "object" ? raw : {};
    } catch (_) { return {}; }
  }

  function write() {
    try { localStorage.setItem(KEY, JSON.stringify(opened)); } catch (_) {}
  }

  function writeLinks() {
    try { localStorage.setItem(LINK_KEY, JSON.stringify(links)); } catch (_) {}
  }

  Crosspost.link = function (aId, bId) {
    const a = String(aId || ""), b = String(bId || "");
    if (!a || !b || a === b) return;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!links[x]) links[x] = [];
      if (links[x].indexOf(y) < 0) links[x].push(y);
    }
    writeLinks();
  };

  /* One hop is enough in practice and cannot loop. */
  Crosspost.linkedIds = function (postId) {
    return new Set(links[String(postId || "")] || []);
  };

  const lower = (s) => String(s == null ? "" : s).toLowerCase();

  /* ------------------------------------------------------------------
   * WHERE THE CONTENT IS
   * ------------------------------------------------------------------ */

  /* Every other post that is the same content, best sellers first.
     Analyze.findLocally does the actual matching — crosspost chain,
     shared link, title fingerprint — against the loaded inventory. Free
     and offline, and the communities someone tracks are exactly the
     ones where a crosspost of theirs matters. */
  Crosspost.copiesOf = function (post) {
    if (!post) return [];
    const found = (window.Analyze && Analyze.findLocally) ? Analyze.findLocally(post) : [];
    const declared = Crosspost.linkedIds(post.id);
    const inventory = (window.AppState && AppState.posts) || [];

    const seen = new Set([post.id]);
    const out = [];
    for (const p of found.concat(inventory.filter((p) => p && declared.has(p.id)))) {
      if (!p || !p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
    return out.sort((a, b) => (b.score || 0) - (a.score || 0));
  };

  /* Home included: the question callers ask is "may I still suggest
     this community", and the one it is already in is not a suggestion. */
  Crosspost.subsWithCopies = function (post) {
    const out = new Set();
    if (!post) return out;
    if (post.subreddit) out.add(lower(post.subreddit));
    for (const p of Crosspost.copiesOf(post)) {
      if (p.subreddit) out.add(lower(p.subreddit));
    }
    return out;
  };

  Crosspost.submitUrl = function (sub, post) {
    if (!sub || !post) return null;
    return Util.buildSubmitUrl(sub, post);
  };

  /* ------------------------------------------------------------------
   * TRACKING
   * ------------------------------------------------------------------ */

  /* The campaign holding this content, by any of its copies. Checking
     the copies as well as the post matters: a campaign started from the
     crosspost rather than the original is still the campaign for this
     story, and offering to start a second one would split the totals. */
  Crosspost.campaignFor = function (post) {
    if (!post || !window.Campaigns) return null;
    const ids = new Set([post.id].concat(Crosspost.copiesOf(post).map((p) => p.id)));
    for (const c of Campaigns.list()) {
      for (const id of (c.postIds || [])) {
        if (ids.has(id)) return c;
      }
    }
    return null;
  };

  /* Start tracking. Only ever called with copies in hand — see the
     header — and it takes exactly the posts that exist rather than the
     communities that were recommended, so the campaign opens as a
     record of what happened rather than a wishlist. */
  Crosspost.track = function (post, name) {
    if (!post) throw new Error("No post to track.");
    const copies = Crosspost.copiesOf(post);
    /* Two communities, not two posts. A campaign totals what the same
       content did in different places; over one community it is a sum
       with one term in it. */
    if (Crosspost.subsWithCopies(post).size < 2) {
      throw new Error("This is only in one community so far, so there is nothing to total yet.");
    }
    return Analyze.campaignFrom({ post: post, elsewhere: copies }, name);
  };

  /* Fold copies that have appeared since into the campaign already
     tracking this content. This is the payoff of the whole loop: you
     cross-post, the next sync of that community turns the copy up, and
     it joins the set it belongs to without anyone filing it. */
  Crosspost.syncCampaign = function (post) {
    const campaign = Crosspost.campaignFor(post);
    if (!campaign) return null;
    const have = new Set(campaign.postIds || []);
    const missing = [post].concat(Crosspost.copiesOf(post))
      .filter((p) => p && p.id && !have.has(p.id));
    if (!missing.length) return null;
    Campaigns.addPostIds(campaign.id, missing.map((p) => p.id));
    return { campaign: campaign, added: missing };
  };

  /* ------------------------------------------------------------------
   * OPENED, BUT NOT YET ACCOUNTED FOR
   * ------------------------------------------------------------------ */

  /* Keyed lowercase so it lines up with everything else that names a
     subreddit, but the spelling is kept: r/SocialistRA read back as
     r/socialistra looks like the app got it wrong. */
  Crosspost.markOpened = function (postId, sub) {
    const id = String(postId || "");
    const key = lower(sub);
    if (!id || !key) return;
    if (!opened[id]) opened[id] = {};
    opened[id][key] = { at: Date.now(), name: String(sub) };
    write();
  };

  function openedAt(rec) {
    return (rec && typeof rec === "object" ? rec.at : rec) || 0;
  }

  /* Communities whose submit page was opened and where no copy has
     turned up since. A sub that now has a copy drops off by itself —
     the intent was fulfilled, and asking about it again would be the
     app failing to notice its own answer. */
  Crosspost.pendingFor = function (post) {
    if (!post) return [];
    const rec = opened[post.id];
    if (!rec) return [];
    const done = Crosspost.subsWithCopies(post);
    return Object.keys(rec)
      .filter((sub) => !done.has(sub))
      .sort((a, b) => openedAt(rec[b]) - openedAt(rec[a]))
      .map((sub) => (rec[sub] && rec[sub].name) || sub);
  };

  Crosspost.clearOpened = function (postId, sub) {
    const id = String(postId || "");
    if (!opened[id]) return;
    if (sub) delete opened[id][lower(sub)];
    else delete opened[id];
    if (opened[id] && !Object.keys(opened[id]).length) delete opened[id];
    write();
  };

  /* Drop intents for communities that now have a copy, so the prompt
     stops asking about work that is visibly done. Returns the names it
     retired, which is what the caller wants to say out loud. */
  Crosspost.reconcile = function (post) {
    if (!post || !opened[post.id]) return [];
    const done = Crosspost.subsWithCopies(post);
    const settled = Object.keys(opened[post.id]).filter((sub) => done.has(sub));
    for (const sub of settled) delete opened[post.id][sub];
    if (!Object.keys(opened[post.id]).length) delete opened[post.id];
    if (settled.length) write();
    return settled;
  };

  Crosspost.reset = function () {
    opened = {};
    links = {};
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem(LINK_KEY);
    } catch (_) {}
  };

  window.Crosspost = Crosspost;
})();
