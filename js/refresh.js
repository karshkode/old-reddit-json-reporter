/* =====================================================================
 * SCOPED REFRESH
 * ---------------------------------------------------------------------
 * Every fetch this app made used to have the same scope: all of it.
 * Adding one subreddit to a hundred and seventy re-read a hundred and
 * seventy-one, and checking whether a campaign had moved meant the same
 * sweep. So the honest advice was to refresh rarely, which is the
 * opposite of what a tool watching live posts should encourage.
 *
 * This module fetches a named part and folds the answer back in:
 *
 *   Refresh.subs(names)     one or more subreddit listings
 *   Refresh.postIds(ids)    named posts, wherever they live
 *   Refresh.campaign(id)    a campaign's posts, by id
 *   Refresh.stale()         whatever has not been read lately
 *   Refresh.everything()    the old full sweep, still here for when
 *                           the scope genuinely is everything
 *
 * Three things make a partial fetch safe:
 *
 *   1. It patches rather than replaces. PostCache.patch only touches
 *      the ids it was handed, so syncing one sub cannot age out the
 *      other hundred and seventy. `App.refreshData` clears state.posts
 *      first and can only be used when the scope really is everything.
 *
 *   2. It bypasses the request cache for its own scope only, via the
 *      `fresh` flag threaded through Reddit.fetchJson. Calling
 *      clearCache() to re-read one sub would make every other sub
 *      re-fetch on next touch, so the cheap sync would quietly make
 *      the next expensive one more expensive.
 *
 *   3. It records what it read, in state.subSync. Without a per-sub
 *      timestamp there is no such thing as a stale subreddit, and
 *      "sync only what needs it" has no way to decide.
 *
 * Because the scope is small, the result can be reported honestly:
 * "12 new, 40 updated, +1.2k upvotes" is a sentence a full refresh
 * could never truthfully write.
 * ===================================================================== */
(function () {
  const Refresh = {};

  /* How long a listing stays worth trusting. Fifteen minutes is not a
   * property of the data — it is roughly how long it takes a busy
   * subreddit's front page to turn over enough that a re-read finds
   * something. Short enough that "sync stale" has work to do, long
   * enough that it does not become the full sweep by another name. */
  const STALE_MS = 15 * 60 * 1000;
  Refresh.STALE_MS = STALE_MS;

  /* Concurrency. The archive starts 429-ing past three listings in
   * flight; post-id batches are one request each so they can run a
   * little wider. */
  const SUB_CONCURRENCY = 3;

  const running = new Set();

  Refresh.busy = function () {
    return running.size > 0;
  };

  /* ------------------------------------------------------------------
   * Freshness
   * ------------------------------------------------------------------ */

  function state() { return window.AppState; }

  /* Split the subs that would take part in a fetch by how long it has
   * been since each was read. A sub nobody has ever fetched is not
   * "very stale", it is unread, and the difference matters: unread
   * subs are why someone pressed sync, stale ones are housekeeping. */
  Refresh.freshness = function (names) {
    const s = state();
    const list = names ? [].concat(names) : Array.from(s.activeSubs);
    const out = { unread: [], stale: [], fresh: [] };
    for (const name of list) {
      const age = s.syncAgeOf(name);
      if (age == null) out.unread.push(name);
      else if (age > STALE_MS) out.stale.push(name);
      else out.fresh.push(name);
    }
    return out;
  };

  /* What a sync would actually fetch: unread first, since those are
   * the ones with no data at all behind them. */
  Refresh.staleSubs = function (names) {
    const f = Refresh.freshness(names);
    return f.unread.concat(f.stale);
  };

  Refresh.ageLabel = function (name) {
    const s = state();
    const rec = s.subSync[String(name || "").toLowerCase()];
    if (!rec || !rec.at) return "never synced";
    if (rec.error) return "failed " + PostCache.formatAge(rec.at);
    return "synced " + PostCache.formatAge(rec.at);
  };

  /* ------------------------------------------------------------------
   * Applying a partial answer
   * ------------------------------------------------------------------ */

  /* Fold freshly-read posts into the inventory and tell the rest of
   * the app the dataset moved. Everything not in `fresh` is left
   * exactly as it was — that is the whole difference between this and
   * a refresh. */
  /* @param opts.adopt  "all" lets posts the inventory has never seen
   *        join it; "existing" updates only the copies already there.
   *        Campaign syncs use "existing": a campaign can point at
   *        posts in subreddits nobody loaded, and quietly filing those
   *        into the inventory would put a handful of posts from an
   *        unloaded sub into the dashboard's per-community analysis,
   *        where they would be read as that community's whole
   *        behaviour. */
  function apply(fresh, opts) {
    opts = opts || {};
    const s = state();
    let incoming = fresh;
    if (opts.adopt === "existing") {
      const known = new Set(s.posts.map((p) => p && p.id));
      incoming = (fresh || []).filter((p) => p && known.has(p.id));
    }
    const patch = PostCache.patch(s.posts, incoming);
    s.posts = patch.posts;

    /* The detail panel caches the post body and comments it fetched.
     * A post whose score just moved has a stale entry there, and
     * reopening it would show the number the sync just corrected. */
    for (const id of patch.changedIds) s.detailCache.delete(id);

    if (patch.added || patch.updated) {
      if (App.persistPostCache) App.persistPostCache().catch(() => {});
    }
    if (opts.render !== false) App.rerenderAll();
    return patch;
  }

  /* One place that decides how a scoped result reads, so a sub sync, a
   * campaign sync and a post sync all describe themselves the same
   * way. Deliberately says "no change" rather than reporting zeroes:
   * finding nothing new is the common outcome and it is not a
   * failure. */
  function summarize(scopeLabel, patch, errors) {
    const failed = (errors && errors.length) || 0;
    const bits = [];
    if (patch.added) bits.push(`${patch.added} new`);
    if (patch.updated) bits.push(`${patch.updated} updated`);
    /* Nothing came back and something errored: the honest headline is
     * the failure, not "no change" — which would read as "I checked,
     * all quiet" when nothing was checked at all. */
    if (!bits.length && failed) {
      return `${scopeLabel} · couldn't be read${failed > 1 ? ` (${failed} failed)` : ""}`;
    }
    let line = bits.length ? `${scopeLabel} · ${bits.join(", ")}` : `${scopeLabel} · no change`;
    if (patch.scoreDelta) {
      line += ` (${patch.scoreDelta > 0 ? "+" : "−"}${Util.fmtNum(Math.abs(patch.scoreDelta))} upvotes)`;
    }
    if (failed) line += ` · ${failed} couldn't be read`;
    return line;
  }
  Refresh.summarize = summarize;

  /* Guard against two syncs of the same thing racing, and against any
   * sync starting while the full sweep is mid-flight and holding
   * state.posts in a half-built condition. */
  function claim(key) {
    const s = state();
    if (s.rendering.light) {
      Util.toast("A full refresh is already running.");
      return false;
    }
    if (running.has(key)) return false;
    running.add(key);
    return true;
  }

  function release(key) {
    running.delete(key);
  }

  /* ------------------------------------------------------------------
   * Subreddit scope
   * ------------------------------------------------------------------ */

  /* Re-read these subreddits' listings and fold the results in.
   *
   * Uses the current listing/window/limit, because the point of a sync
   * is "the same question again, now" — a sub read under different
   * settings than its neighbours would quietly make the dashboard's
   * comparisons meaningless. */
  Refresh.subs = async function (names, opts) {
    opts = opts || {};
    const s = state();
    /* Normalised the same way state.addSubs normalises on the way in,
     * so a name reaching this from a chip, a catalog row or a raw
     * "r/foo" string all resolve to the one ledger key. */
    const list = Util.uniqBy(
      [].concat(names || []).map((n) => Util.normalizeSubName(n)).filter(Boolean),
      (n) => n
    );
    if (!list.length) return null;
    const key = "subs:" + list.map((n) => n.toLowerCase()).sort().join(",");
    if (!claim(key)) return null;

    const label = opts.label || (list.length === 1
      ? "r/" + list[0]
      : `${list.length} subreddits`);
    const showProgress = opts.progress !== false;
    const collected = [];
    const errors = [];
    let done = 0;

    if (showProgress) Util.setProgress(0, `Syncing ${label}…`);

    try {
      await Util.pmap(list, SUB_CONCURRENCY, async (sub) => {
        try {
          const posts = await Reddit.fetchSubredditListing(sub, {
            listing: s.listing,
            t: s.timeWindow,
            limit: s.limit,
            fresh: true,
          });
          for (const p of posts) collected.push(p);
          s.markSynced(sub, { count: posts.length });
        } catch (err) {
          const message = (err && err.message) || String(err);
          errors.push({ sub, message });
          s.markSynced(sub, { count: 0, error: message });
        } finally {
          done++;
          if (showProgress) {
            Util.setProgress(
              Math.min(95, (done / list.length) * 100),
              `Syncing ${label}… ${done}/${list.length}`
            );
          }
        }
      });

      s.persistSubSync();
      /* If the only thing making the dataset stale was subs that had
       * never been read, and none are left, it is not stale any more.
       * Leaving the flag set would keep offering a full sweep that has
       * nothing to find. */
      if (s.pendingChanges && s.pendingScope === "subs" && !Refresh.staleSubs().length) {
        s.pendingChanges = false;
      }
      const patch = apply(collected, opts);
      const line = summarize(label, patch, errors);
      if (showProgress) Util.hideProgress(line);
      if (opts.toast !== false) Util.toast(line, errors.length ? "error" : "");
      return Object.assign({ scope: "subs", subs: list, errors, label, line }, patch);
    } finally {
      release(key);
      if (showProgress) Refresh.repaintBanner();
    }
  };

  /* Everything that has not been read inside the stale window,
   * including everything that has never been read at all. This is the
   * one the main button runs, so it has to be honest when there is
   * nothing to do rather than quietly doing the full sweep instead. */
  Refresh.stale = async function (opts) {
    opts = opts || {};
    const due = Refresh.staleSubs();
    if (!due.length) {
      if (opts.toast !== false) Util.toast("Everything is already up to date.");
      return null;
    }
    const f = Refresh.freshness();
    const label = f.unread.length && !f.stale.length
      ? `${f.unread.length} new subreddit${f.unread.length === 1 ? "" : "s"}`
      : `${due.length} subreddit${due.length === 1 ? "" : "s"}`;
    return Refresh.subs(due, Object.assign({ label }, opts));
  };

  /* ------------------------------------------------------------------
   * Post scope
   * ------------------------------------------------------------------ */

  /* Re-read named posts wherever they live. Cheap enough to run on a
   * single post from the detail panel, and the only way to sync a post
   * whose subreddit is not loaded — a campaign's posts, or one pasted
   * in by hand. */
  Refresh.postIds = async function (ids, opts) {
    opts = opts || {};
    const clean = Util.uniqBy(
      [].concat(ids || []).map((id) => String(id || "").replace(/^t3_/, "").trim()).filter(Boolean),
      (x) => x
    );
    if (!clean.length) return null;
    const key = "posts:" + clean.slice().sort().join(",");
    if (!claim(key)) return null;

    const label = opts.label || (clean.length === 1
      ? "this post"
      : `${clean.length} posts`);
    const showProgress = opts.progress !== false;
    if (showProgress) Util.setProgress(null, `Syncing ${label}…`);

    try {
      let fetched = [];
      let failure = null;
      try {
        fetched = await Reddit.fetchPostsByIds(clean, { fresh: true });
      } catch (err) {
        failure = (err && err.message) || String(err);
      }
      if (!fetched.length && fetched._lastError && !failure) {
        failure = fetched._lastError.message || String(fetched._lastError);
      }

      const errors = failure ? [{ message: failure }] : [];
      /* An id the archive did not return is not an error — a deleted
       * post simply stops existing there — but it is worth saying,
       * since the alternative is a sync that silently does nothing. */
      const missing = clean.length - fetched.length;
      const patch = apply(fetched, opts);
      let line = summarize(label, patch, errors);
      if (!failure && missing > 0) line += ` · ${missing} not in the archive`;
      if (showProgress) Util.hideProgress(line);
      if (opts.toast !== false) Util.toast(line, failure ? "error" : "");
      return Object.assign({ scope: "posts", ids: clean, errors, missing, label, line, fetched }, patch);
    } finally {
      release(key);
      if (showProgress) Refresh.repaintBanner();
    }
  };

  /* One post, with its comments, for the detail panel.
   *
   * Separate from postIds because the panel needs the comment thread
   * too, and /comments returns both in a single request — going
   * through postIds and then re-opening the panel would ask the
   * archive for the same post twice. */
  Refresh.post = async function (postId, opts) {
    opts = opts || {};
    const id = String(postId || "").replace(/^t3_/, "").trim();
    if (!id) return null;
    const key = "post:" + id;
    if (!claim(key)) return null;
    try {
      const data = await Reddit.fetchPostWithComments(id, {
        commentLimit: opts.commentLimit || 50,
        fresh: true,
      });
      if (!data || !data.post) throw new Error("the archive no longer has this post");
      const patch = apply([data.post], { render: opts.render });
      /* apply() drops the detail cache for anything that moved; this
       * is the fresh replacement for it. */
      state().detailCache.set(data.post.id, data);
      const line = summarize("This post", patch, []);
      if (opts.toast !== false) Util.toast(line);
      return Object.assign({ scope: "post", data, line }, patch);
    } catch (err) {
      if (opts.toast !== false) {
        Util.toast(`Couldn't sync this post: ${(err && err.message) || err}`, "error");
      }
      return null;
    } finally {
      release(key);
    }
  };

  /* ------------------------------------------------------------------
   * Campaign scope
   * ------------------------------------------------------------------ */

  /* Re-read one campaign's posts and republish its totals.
   *
   * The campaign workspace's own Refresh used to call fetchAggregated,
   * which resolves ids into a summary but never writes the posts back
   * to the inventory. So a campaign could show a score the Posts table
   * disagreed with, and syncing the campaign again would re-resolve
   * the same ids "locally" from those stale copies. Going through
   * postIds fixes both: the inventory is the single copy, and the
   * campaign totals are computed from it. */
  Refresh.campaign = async function (idOrCampaign, opts) {
    opts = opts || {};
    const campaign = typeof idOrCampaign === "string"
      ? Campaigns.get(idOrCampaign)
      : idOrCampaign;
    if (!campaign) return null;
    const ids = (campaign.postIds || []).filter((id) => !Util.isShareUrl(id));
    if (!ids.length) {
      if (opts.toast !== false) Util.toast("That campaign has no posts to sync yet.");
      return null;
    }
    const result = await Refresh.postIds(ids, Object.assign({
      label: campaign.name,
      render: false,
      adopt: "existing",
    }, opts));
    if (!result) return null;
    /* Republish from the inventory the sync just updated, plus the
     * posts it read that live outside it. Local-only, because
     * everything it could ask the network for was asked a moment
     * ago. */
    await App.publishCampaign(campaign, result.fetched);
    App.rerenderAll();
    return result;
  };

  /* Every campaign at once, still far narrower than a full refresh:
   * one batched id lookup covers the lot, against one listing read per
   * subreddit for the sweep. */
  Refresh.campaigns = async function (opts) {
    opts = opts || {};
    const list = Campaigns.list();
    if (!list.length) {
      if (opts.toast !== false) Util.toast("No campaigns to sync.");
      return null;
    }
    const ids = [];
    for (const c of list) {
      for (const id of c.postIds || []) {
        if (!Util.isShareUrl(id)) ids.push(id);
      }
    }
    if (!ids.length) {
      if (opts.toast !== false) Util.toast("No campaign posts to sync yet.");
      return null;
    }
    const label = `${list.length} campaign${list.length === 1 ? "" : "s"}`;
    const result = await Refresh.postIds(ids, Object.assign({
      label,
      render: false,
      adopt: "existing",
    }, opts));
    if (!result) return null;
    for (const c of list) await App.publishCampaign(c, result.fetched);
    App.rerenderAll();
    return result;
  };

  /* ------------------------------------------------------------------
   * The full sweep
   * ------------------------------------------------------------------ */

  /* Still the right answer when the scope really is everything —
   * changing the listing or the time window invalidates every sub at
   * once, and no amount of patching fixes that. refreshData stamps
   * the ledger itself, so the stale list is empty afterwards however
   * the sweep was reached. */
  Refresh.everything = function (force) {
    return App.refreshData(force == null ? true : force);
  };

  /* ------------------------------------------------------------------
   * The action banner
   * ------------------------------------------------------------------ */

  /* What the main button should offer right now, given what is loaded
   * and how old it is. Returned rather than applied so the wording can
   * be asserted without a DOM. */
  Refresh.describeState = function () {
    const s = state();
    if (!s.activeSubs.size) {
      return { phase: "pending", action: "go", label: "Go", icon: "▶",
        text: "Add at least one subreddit, then tap Go." };
    }
    /* Nothing fetched yet, or the listing / window / limit changed
     * underneath what was fetched: every sub is equally out of date,
     * so the narrow option would be the wide one anyway. A change to
     * the loaded set is different — the subs already read are still
     * fine, and the new ones show up as unread below. */
    if (!s.posts.length || (s.pendingChanges && s.pendingScope !== "subs")) {
      return { phase: "pending", action: "go", label: "Go", icon: "▶",
        text: App.describePendingFetch() };
    }
    const f = Refresh.freshness();
    const due = f.unread.length + f.stale.length;
    if (!due) {
      return { phase: "loaded", action: "all", label: "Refresh", icon: "↻",
        text: `${Util.fmtNum(s.posts.length)} posts · all ${f.fresh.length} subreddit${f.fresh.length === 1 ? "" : "s"} synced within the last ${Math.round(STALE_MS / 60000)} min.` };
    }
    const what = f.unread.length && !f.stale.length
      ? `${f.unread.length} subreddit${f.unread.length === 1 ? "" : "s"} not fetched yet`
      : `${due} of ${f.unread.length + f.stale.length + f.fresh.length} subreddits need a sync`;
    return {
      phase: "loaded", action: "stale", label: `Sync ${due}`, icon: "↻",
      text: `${Util.fmtNum(s.posts.length)} posts · ${what}.`,
    };
  };

  Refresh.repaintBanner = function () {
    const d = Refresh.describeState();
    Util.setActionPhase(d.phase, d.text, { label: d.label, icon: d.icon, action: d.action });
  };

  /* What the main button does depends on what the banner is currently
   * offering, so the two can never disagree. */
  Refresh.runPrimary = function () {
    const d = Refresh.describeState();
    if (d.action === "stale") return Refresh.stale();
    return Refresh.everything(true);
  };

  window.Refresh = Refresh;
})();
