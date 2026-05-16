/* Campaign manager.
 *
 * A campaign = { id, name, goalScore, goalComments, postIds[], createdAt }.
 *
 * Storage strategy: maintain an in-memory mirror as the source of truth for
 * the page session, and try to persist it to localStorage. If persistence
 * fails (iOS Safari Private Browsing, "Block All Cookies", quota exceeded,
 * embedded WebView with storage disabled), the in-memory list still works
 * inside this tab and `Campaigns.persistError` records why.
 *
 * This guards against the previous failure mode where `localStorage.setItem`
 * threw synchronously and silently inside `Campaigns.add`, destroying any
 * record of the just-created campaign.
 */
(function () {
  const KEY = "rj.campaigns";
  const Campaigns = {};

  let mirror = null;
  let persistError = null;

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      persistError = e && e.message ? e.message : String(e);
      return [];
    }
  }

  function ensureMirror() {
    if (mirror === null) mirror = loadFromStorage();
    return mirror;
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(mirror));
      persistError = null;
      return true;
    } catch (e) {
      persistError = e && e.message ? e.message : String(e);
      return false;
    }
  }

  Campaigns.canPersist = function () {
    /* Probe localStorage with a short throwaway key. Catches:
     * - Private Browsing on older Safari (throws)
     * - Cookies blocked / storage disabled (throws SecurityError)
     * - Quota exceeded
     */
    try {
      const k = "rj.probe." + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(k, "1");
      const ok = localStorage.getItem(k) === "1";
      localStorage.removeItem(k);
      return ok;
    } catch (_) {
      return false;
    }
  };

  Campaigns.persistErrorMessage = function () { return persistError; };

  Campaigns.list = function () { return ensureMirror().slice(); };

  Campaigns.add = function (data) {
    ensureMirror();
    const id = Math.random().toString(36).slice(2, 10);
    const c = {
      id,
      name: String(data && data.name || "Untitled campaign"),
      goalScore: Number(data && data.goalScore) || 0,
      goalComments: Number(data && data.goalComments) || 0,
      postIds: Util.uniqBy(((data && data.postIds) || []).map(String), (x) => x),
      createdAt: Date.now(),
    };
    mirror.push(c);
    persist();
    return c;
  };

  Campaigns.remove = function (id) {
    ensureMirror();
    mirror = mirror.filter((c) => c.id !== id);
    persist();
  };

  Campaigns.get = function (id) {
    return ensureMirror().find((c) => c.id === id) || null;
  };

  Campaigns.update = function (id, patch) {
    ensureMirror();
    const i = mirror.findIndex((c) => c.id === id);
    if (i < 0) return null;
    mirror[i] = Object.assign({}, mirror[i], patch);
    persist();
    return mirror[i];
  };

  /* Fetch live aggregated data for a campaign.
   *
   * If the caller passes options.fromPosts (typically the dashboard's
   * already-loaded subreddit posts) we resolve as many campaign IDs as
   * possible from that local cache before going to the network. The
   * remaining IDs are fetched via Reddit.fetchPostsByIds, which itself
   * falls back to per-ID /comments lookups if /by_id fails.
   *
   * options.skipNetwork = true returns just the local matches (useful for
   * an instant first paint before a slow refresh). */
  Campaigns.fetchAggregated = async function (campaign, options) {
    options = options || {};
    const localPosts = Array.isArray(options.fromPosts) ? options.fromPosts : [];
    const idSet = new Set(campaign.postIds);
    const localById = new Map();
    for (const p of localPosts) {
      if (p && p.id && idSet.has(p.id)) localById.set(p.id, p);
    }
    const knownPosts = Array.from(localById.values());
    const idsToFetch = campaign.postIds.filter((id) => !localById.has(id));

    let fetched = [];
    if (!options.skipNetwork && idsToFetch.length) {
      fetched = await Reddit.fetchPostsByIds(idsToFetch);
    }

    /* Merge local + fetched, then dedupe by id. */
    const seen = new Set();
    const posts = [];
    for (const p of [...knownPosts, ...fetched]) {
      if (p && !seen.has(p.id)) { seen.add(p.id); posts.push(p); }
    }

    const totalScore = posts.reduce((a, b) => a + (b.score || 0), 0);
    const totalComments = posts.reduce((a, b) => a + (b.num_comments || 0), 0);
    const totalAwards = posts.reduce((a, b) => a + (b.total_awards || 0), 0);
    const totalViews = posts.reduce((a, b) => a + (b.view_count || 0), 0);
    const subs = Array.from(new Set(posts.map((p) => p.subreddit))).filter(Boolean);
    const missing = campaign.postIds.filter((id) => !posts.find((p) => p.id === id));
    return {
      posts, totalScore, totalComments, totalAwards, totalViews,
      subs, missing,
      resolvedFromLocal: knownPosts.length,
      resolvedFromNetwork: fetched.length,
      progressScore: campaign.goalScore ? Math.min(1, totalScore / campaign.goalScore) : null,
      progressComments: campaign.goalComments ? Math.min(1, totalComments / campaign.goalComments) : null,
    };
  };

  /* Manual import / export — useful when storage is broken so the user
   * can copy their campaigns to a note app or another device. */
  Campaigns.exportJson = function () {
    return JSON.stringify(ensureMirror(), null, 2);
  };
  Campaigns.importJson = function (text) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("expected an array");
      mirror = parsed;
      persist();
      return true;
    } catch (_) { return false; }
  };

  window.Campaigns = Campaigns;
})();
