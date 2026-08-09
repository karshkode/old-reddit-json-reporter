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
  function summarize(scopeLabel, patch, errors, opts) {
    opts = opts || {};
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
    /* When the user asked for 500 and a community only yielded 80, say
     * so. Silence here is what made a shortfall look like a hardcoded
     * page size. */
    if (opts.perSubGot && opts.perSubGot.length && opts.target) {
      const short = opts.perSubGot.filter((r) => !r.error && r.got < opts.target);
      if (short.length === 1) {
        line += ` · r/${short[0].sub} returned ${short[0].got} of ${opts.target}`;
      } else if (short.length > 1) {
        const avg = Math.round(short.reduce((n, r) => n + r.got, 0) / short.length);
        line += ` · ${short.length} subs under ${opts.target}/sub (avg ${avg})`;
      } else if (opts.perSubGot.length === 1) {
        line += ` · ${opts.perSubGot[0].got} of ${opts.target} asked`;
      }
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

    const target = Math.max(1, Number(s.limit) || 100);
    const perSubGot = [];

    try {
      await Util.pmap(list, SUB_CONCURRENCY, async (sub) => {
        try {
          const posts = await fetchUpTo(sub, target, s);
          for (const p of posts) collected.push(p);
          perSubGot.push({ sub, got: posts.length, want: target });
          s.markSynced(sub, { count: posts.length, want: target });
        } catch (err) {
          const message = (err && err.message) || String(err);
          errors.push({ sub, message });
          perSubGot.push({ sub, got: 0, want: target, error: message });
          s.markSynced(sub, { count: 0, error: message });
        } finally {
          done++;
          if (showProgress) {
            Util.setProgress(
              Math.min(95, (done / list.length) * 100),
              `Syncing ${label}… ${done}/${list.length} · ${target}/sub`
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
      const line = summarize(label, patch, errors, { perSubGot, target });
      if (showProgress) Util.hideProgress(line);
      if (opts.toast !== false) Util.toast(line, errors.length ? "error" : "");
      return Object.assign({ scope: "subs", subs: list, errors, label, line, perSubGot, target }, patch);
    } finally {
      release(key);
      if (showProgress) Refresh.repaintBanner();
    }
  };

  /* Pull up to `target` posts for one subreddit, using the configured
   * listing first and filling any shortfall from `new`.
   *
   * Hot/top over a week often cannot produce 500 confirmed scores —
   * the archive only has about five days of settled posts in that
   * window, and a quiet community may not have posted that many. The
   * old path stopped there and quietly looked like a hardcoded 100.
   * Asking `new` for the remainder is how a 500 setting becomes 500
   * posts when the community actually has them. */
  async function fetchUpTo(sub, target, s) {
    const listing = s.listing || "hot";
    const time = s.timeWindow || "week";
    const primary = await Reddit.fetchSubredditListing(sub, {
      listing: listing,
      t: time,
      limit: target,
      fresh: true,
    });

    /* Ranked listings (hot/top) start at the archive's confirmed-score
     * cliff (~48h), so the freshest posts never appear even when the
     * primary page is "full". Always union a page of `new` so the
     * inventory reaches as recent as the archive has filed — live
     * scores then cover the blind window. */
    if (listing === "new") return primary.slice(0, target);

    const need = Math.max(target - primary.length, Math.min(50, Math.ceil(target * 0.15)));
    let fill = [];
    try {
      fill = await Reddit.fetchSubredditListing(sub, {
        listing: "new",
        /* Widen the window for the fill so a week-bound hot listing
         * that ran dry can still reach the configured count from the
         * community's actual history. */
        t: time === "hour" || time === "day" ? "week"
          : time === "week" ? "month"
            : time === "month" ? "year" : "all",
        limit: Math.max(need, 25),
        fresh: true,
      });
    } catch (_) {
      return primary.slice(0, target);
    }
    if (!fill || !fill.length) return primary.slice(0, target);

    const seen = new Set(primary.map((p) => p.id));
    /* Prefer newest fill posts first so the gap above the score cliff
     * is what lands, then pad with older ones if still under target. */
    const recent = fill.slice().sort((a, b) => (b.created_utc || 0) - (a.created_utc || 0));
    const out = primary.slice();
    for (const p of recent) {
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
      if (out.length >= target) break;
    }
    return out;
  }
  Refresh.fetchUpTo = fetchUpTo;

  /* Drop inventory posts older than the configured time window.
   * Sync patches do not age anything out on their own — without this,
   * widening or narrowing the window left stale month-old posts sitting
   * next to a "week" setting and muddying every chart. Imported and
   * syndicated posts are kept: the user brought those in on purpose. */
  Refresh.pruneOlderThanWindow = function (opts) {
    opts = opts || {};
    const s = state();
    const key = s.timeWindow || "week";
    const secs = ({
      hour: 3600,
      day: 86400,
      week: 604800,
      month: 2592000,
      year: 31536000,
      all: 0,
    })[key];
    if (!secs) {
      if (opts.toast !== false) Util.toast("Time window is All — nothing to prune.");
      return { removed: 0, window };
    }
    const cutoff = Math.floor(Date.now() / 1000) - secs;
    const before = s.posts.length;
    const kept = [];
    let removed = 0;
    for (const p of s.posts) {
      if (!p) continue;
      if (p.imported || p.syndicated) { kept.push(p); continue; }
      if ((p.created_utc || 0) < cutoff) { removed++; continue; }
      kept.push(p);
    }
    if (!removed) {
      if (opts.toast !== false) Util.toast(`Nothing older than ${key} to drop.`);
      return { removed: 0, kept: before, window };
    }
    s.posts = kept;
    if (App.persistPostCache) App.persistPostCache().catch(() => {});
    if (opts.render !== false) App.rerenderAll();
    const line = `Dropped ${Util.fmtNum(removed)} post${removed === 1 ? "" : "s"} older than ${key} · ${Util.fmtNum(kept.length)} kept`;
    if (opts.toast !== false) Util.toast(line);
    return { removed, kept: kept.length, window: key, line };
  };

  /* Every loaded subreddit's listing again, folded in rather than
   * swapped for. Reading a listing is the only way to learn a post
   * exists, so "check for new posts" is unavoidably one read per sub —
   * the same request count as the full sweep. What differs is what
   * survives it: this patches, so a post that has since fallen off the
   * front page, or arrived by import or by pasted link, is still there
   * afterwards, and the answer can be counted ("+12 new, 40 updated")
   * because the before and after are comparable. Refresh.everything
   * empties the inventory first and can say nothing of the sort. */
  Refresh.newPosts = function (opts) {
    opts = opts || {};
    const s = state();
    const list = Array.from(s.activeSubs);
    if (!list.length) {
      if (opts.toast !== false) Util.toast("No subreddits loaded to sync.");
      return Promise.resolve(null);
    }
    return Refresh.subs(list, Object.assign({
      label: `${list.length} subreddit${list.length === 1 ? "" : "s"}`,
    }, opts));
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
    /* The line leads with whatever the button is about, because it is
     * one line and it ellipsises on a phone — the post count is
     * context, the thing needing a fetch is the point. */
    const f = Refresh.freshness();
    const due = f.unread.length + f.stale.length;
    const total = f.unread.length + f.stale.length + f.fresh.length;
    const posts = `${Util.fmtNum(s.posts.length)} posts loaded`;
    /* Nothing overdue, but "nothing overdue" is not "nothing new" —
     * subreddits keep posting inside the fifteen-minute window. So the
     * button still offers a fetch; it just offers the one that adds to
     * the inventory instead of the one that empties it and starts
     * over. Wiping several thousand posts to re-collect them is a
     * thing to choose on purpose, from the menu, not the thing that
     * happens when someone taps the only button on screen. */
    if (!due) {
      return { phase: "loaded", action: "new", label: "Sync new", icon: "↻",
        text: `All ${total} subreddit${total === 1 ? "" : "s"} read recently · ${posts}.` };
    }
    const what = f.unread.length && !f.stale.length
      ? `${f.unread.length} subreddit${f.unread.length === 1 ? "" : "s"} not fetched yet`
      : `${due} of ${total} subreddits out of date`;
    return {
      phase: "loaded", action: "stale", label: `Sync ${due}`, icon: "↻",
      text: `${what} · ${posts}.`,
    };
  };

  Refresh.repaintBanner = function () {
    const d = Refresh.describeState();
    Util.setActionPhase(d.phase, d.text, { label: d.label, icon: d.icon, action: d.action });
  };

  /* What the button should say when something else is driving the
   * banner and has only a message to write — the end of a fetch, say,
   * which owns the line but has no business deciding the next offer. */
  Util.actionOffer = function () {
    const d = Refresh.describeState();
    return { label: d.label, icon: d.icon, action: d.action };
  };

  /* ------------------------------------------------------------------
   * WATCHING A POST THAT IS STILL MOVING
   * ------------------------------------------------------------------ */

  /* Every scope above is something the user asked for. This one is not:
   * it is the answer to "I just posted, is it going anywhere", which is
   * a question nobody wants to press a button to re-ask every ninety
   * seconds.
   *
   * It only covers posts in the window where the archive is blind —
   * under about a day and a half old — because those are the only ones
   * whose numbers are wrong, and it only runs while the tab is in front
   * of you, because polling on behalf of a tab nobody is looking at is
   * how a well-meaning feature becomes rude. */
  const WATCH_MS = 90 * 1000;
  const WATCH_CAP = 200;

  let watchTimer = null;
  let watching = false;
  let lastWatch = { at: 0, count: 0, moved: 0 };

  Refresh.watchState = function () {
    return {
      on: watching && !!(window.Live && Live.available()),
      count: Refresh.watchSet().length,
      at: lastWatch.at,
      moved: lastWatch.moved,
    };
  };

  /* Campaign posts first, because a campaign is a statement that these
   * particular posts matter. Anything else young enough to be moving
   * comes after, up to the cap. */
  Refresh.watchSet = function () {
    if (!window.Live || !Live.available()) return [];
    const s = state();
    const byId = new Map();
    for (const p of s.posts || []) if (p && p.id) byId.set(String(p.id), p);

    const picked = [];
    const seen = new Set();
    const take = (post) => {
      if (!post || seen.has(post.id)) return;
      if (!Live.inBlindWindow(post)) return;
      seen.add(post.id);
      picked.push(post);
    };

    for (const c of (window.Campaigns ? Campaigns.list() : [])) {
      for (const id of c.postIds || []) take(byId.get(String(id)));
    }
    for (const p of s.posts || []) {
      if (picked.length >= WATCH_CAP) break;
      take(p);
    }
    return picked.slice(0, WATCH_CAP);
  };

  async function tick() {
    if (document.visibilityState === "hidden") return;
    if (Refresh.busy()) return;
    const set = Refresh.watchSet();
    if (!set.length) return;

    const fresh = await Live.lookup(set.map((p) => p.id));
    if (!fresh || !fresh.length) return;

    /* Silent by design. This did not happen because anybody asked, so
     * it must not take over the banner, raise a toast, or move the page
     * under someone mid-read. It patches, notes what changed, and lets
     * the next render pick it up. */
    const patch = apply(fresh, { render: false, toast: false, adopt: "existing" });
    lastWatch = { at: Date.now(), count: set.length, moved: patch.updated };
    if (patch.updated) {
      App.rerenderAll();
      for (const c of (window.Campaigns ? Campaigns.list() : [])) {
        if (state().campaignSummaries && state().campaignSummaries[c.id]) {
          App.publishCampaign(c, fresh).catch(() => {});
        }
      }
    }
    Refresh.repaintWatch();
  }

  Refresh.repaintWatch = function () {
    if (window.UI && UI.renderWatchBadge) UI.renderWatchBadge(Refresh.watchState());
  };

  Refresh.startWatching = function () {
    if (watchTimer) return;
    watching = true;
    watchTimer = setInterval(() => { tick().catch(() => {}); }, WATCH_MS);
    document.addEventListener("visibilitychange", () => {
      /* Coming back to the tab is the moment the number on screen is
       * most likely to be wrong, so read it then rather than waiting
       * out the rest of the interval. */
      if (document.visibilityState === "visible") tick().catch(() => {});
    });
    tick().catch(() => {});
    Refresh.repaintWatch();
  };

  Refresh.stopWatching = function () {
    watching = false;
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    Refresh.repaintWatch();
  };

  /* A one-off read of everything currently worth watching, for the
   * button that says so. */
  Refresh.watchNow = async function () {
    if (!window.Live || !Live.available()) {
      Util.toast("Live scores are off — turn them on in Settings.");
      return null;
    }
    const set = Refresh.watchSet();
    if (!set.length) {
      Util.toast("Nothing new enough to watch. The archive already has real numbers for everything here.");
      return null;
    }
    return Refresh.postIds(set.map((p) => p.id), {
      label: set.length === 1 ? "this post" : `${set.length} recent posts`,
      adopt: "existing",
    });
  };

  /* What the main button does depends on what the banner is currently
   * offering, so the two can never disagree. */
  Refresh.runPrimary = function () {
    const d = Refresh.describeState();
    if (d.action === "stale") return Refresh.stale();
    if (d.action === "new") return Refresh.newPosts();
    return Refresh.everything(true);
  };

  window.Refresh = Refresh;
})();
