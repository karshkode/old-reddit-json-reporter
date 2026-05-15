/* Campaign manager.
 *
 * A campaign = { id, name, goalScore, goalComments, postIds[], createdAt }.
 * Stored in localStorage so users can reopen the report and keep their lists.
 *
 * Aggregation pulls live post data via Reddit.fetchPostsByIds, then sums the
 * score/comment/award totals and reports goal progress.
 */
(function () {
  const KEY = "rj.campaigns";
  const Campaigns = {};

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }

  function save(list) {
    localStorage.setItem(KEY, JSON.stringify(list));
  }

  Campaigns.list = function () { return load(); };

  Campaigns.add = function (data) {
    const list = load();
    const id = Math.random().toString(36).slice(2, 10);
    const c = {
      id,
      name: String(data.name || "Untitled campaign"),
      goalScore: Number(data.goalScore) || 0,
      goalComments: Number(data.goalComments) || 0,
      postIds: Util.uniqBy((data.postIds || []).map(String), (x) => x),
      createdAt: Date.now(),
    };
    list.push(c);
    save(list);
    return c;
  };

  Campaigns.remove = function (id) {
    save(load().filter((c) => c.id !== id));
  };

  Campaigns.get = function (id) {
    return load().find((c) => c.id === id) || null;
  };

  Campaigns.update = function (id, patch) {
    const list = load();
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return null;
    list[i] = Object.assign({}, list[i], patch);
    save(list);
    return list[i];
  };

  Campaigns.fetchAggregated = async function (campaign) {
    const posts = await Reddit.fetchPostsByIds(campaign.postIds);
    const totalScore = posts.reduce((a, b) => a + (b.score || 0), 0);
    const totalComments = posts.reduce((a, b) => a + (b.num_comments || 0), 0);
    const totalAwards = posts.reduce((a, b) => a + (b.total_awards || 0), 0);
    const totalViews = posts.reduce((a, b) => a + (b.view_count || 0), 0);
    const subs = Array.from(new Set(posts.map((p) => p.subreddit))).filter(Boolean);
    const missing = campaign.postIds.filter((id) => !posts.find((p) => p.id === id));
    return {
      posts, totalScore, totalComments, totalAwards, totalViews,
      subs, missing,
      progressScore: campaign.goalScore ? Math.min(1, totalScore / campaign.goalScore) : null,
      progressComments: campaign.goalComments ? Math.min(1, totalComments / campaign.goalComments) : null,
    };
  };

  window.Campaigns = Campaigns;
})();
