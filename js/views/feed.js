/* =====================================================================
 * FEED VIEWER — Reddit-like post feed inside the app
 * ---------------------------------------------------------------------
 * Opens loaded posts in a familiar vertical feed so you can read titles,
 * bodies, link previews and scores without leaving for reddit.com.
 * Cross-post / Plan actions stay one tap away from each card.
 * ===================================================================== */
(function () {
  "use strict";

  const View = {};
  const SIDEBAR_ID = "feed-viewer";

  let posts = [];
  let focusId = null;
  let title = "Feed";

  const esc = (s) => Util.escapeHtml(s == null ? "" : String(s));

  function trunc(s, n) {
    const t = String(s == null ? "" : s);
    return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
  }

  function scoreLabel(n) {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 10000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return Util.fmtNum(v);
  }

  function mediaOf(post) {
    if (!post) return null;
    if (post.over_18) return { kind: "nsfw" };
    const url = post.url_dest || post.url || "";
    const thumb = post.media_thumbnail
      || (post.thumbnail && /^https?:\/\//i.test(post.thumbnail) ? post.thumbnail : "");
    if (post.is_video || (window.Util && Util.isRedditHostedMedia && Util.isRedditHostedMedia(url) && /v\.redd\.it/i.test(url))) {
      return {
        kind: "video",
        src: post.media_fallback_url || "",
        poster: thumb || "",
        href: post.permalink || url,
      };
    }
    if (post.is_gallery || /\/gallery\//i.test(url)) {
      return { kind: "gallery", poster: thumb || "", href: post.permalink || url };
    }
    if (thumb && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(thumb) || (url && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url))) {
      const img = (url && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) ? url : thumb;
      return { kind: "image", src: img, href: post.permalink || url };
    }
    if (!post.is_self && url && !(window.Util && Util.isRedditCommentsUrl && Util.isRedditCommentsUrl(url))) {
      let host = post.domain || "";
      try { host = host || new URL(url).hostname.replace(/^www\./, ""); } catch (_) {}
      return { kind: "link", href: url, host: host, poster: thumb || "" };
    }
    return null;
  }

  function mediaHtml(post) {
    const m = mediaOf(post);
    if (!m) return "";
    if (m.kind === "nsfw") {
      return `<div class="feed-media feed-media-nsfw" aria-label="NSFW media hidden">NSFW</div>`;
    }
    if (m.kind === "video") {
      if (m.src) {
        return `<div class="feed-media feed-media-video">
          <video controls playsinline preload="metadata" poster="${esc(m.poster)}" src="${esc(m.src)}"></video>
        </div>`;
      }
      return `<a class="feed-media feed-media-video is-link" href="${esc(m.href)}" target="_blank" rel="noopener">
        ${m.poster ? `<img src="${esc(m.poster)}" alt="" loading="lazy" />` : `<span class="feed-media-empty">Video</span>`}
        <span class="feed-media-play" aria-hidden="true">▶</span>
      </a>`;
    }
    if (m.kind === "image") {
      return `<button type="button" class="feed-media feed-media-image" data-action="feed-media" data-src="${esc(m.src)}" data-alt="${esc(post.title || "")}">
        <img src="${esc(m.src)}" alt="" loading="lazy" />
      </button>`;
    }
    if (m.kind === "gallery") {
      return `<a class="feed-media feed-media-gallery" href="${esc(m.href)}" target="_blank" rel="noopener">
        ${m.poster ? `<img src="${esc(m.poster)}" alt="" loading="lazy" />` : `<span class="feed-media-empty">Gallery</span>`}
        <span class="feed-media-badge">Gallery</span>
      </a>`;
    }
    if (m.kind === "link") {
      return `<a class="feed-media feed-media-link" href="${esc(m.href)}" target="_blank" rel="noopener">
        ${m.poster ? `<img src="${esc(m.poster)}" alt="" loading="lazy" />` : ""}
        <span class="feed-media-link-meta">
          <span class="feed-media-host">${esc(m.host || "link")}</span>
          <span class="feed-media-open">Open ↗</span>
        </span>
      </a>`;
    }
    return "";
  }

  function bodyHtml(post) {
    const text = String(post.selftext || "").trim();
    if (!text) return "";
    const short = text.length > 480;
    const shown = short ? trunc(text, 480) : text;
    return `<div class="feed-body${short ? " is-clamped" : ""}">${esc(shown)}</div>`;
  }

  function audienceBadge(post) {
    const aud = window.AppState && AppState.audienceByPost
      ? AppState.audienceByPost.get(post.id)
      : null;
    if (!aud || !aud.total) return "";
    const cls = aud.label === "supportive" ? "good"
      : aud.label === "hostile" ? "bad"
      : aud.label === "mixed" ? "warn" : "info";
    return `<span class="badge ${cls} feed-audience" title="Comment-thread tone">${esc(aud.label)}</span>`;
  }

  function cardHtml(post, opts) {
    opts = opts || {};
    const active = post.id === focusId;
    const expanded = opts.expanded || active;
    const flair = post.flair
      ? `<span class="tag flair">${esc(post.flair)}</span>`
      : "";
    const when = post.created_utc ? Util.relTime(post.created_utc) : "";
    const media = expanded ? mediaHtml(post) : (function () {
      const m = mediaOf(post);
      if (!m || m.kind === "nsfw") return mediaHtml(post);
      /* Compact: prefer thumb strip in list mode for long feeds. */
      if (!expanded && (m.kind === "image" || m.kind === "video" || m.kind === "gallery" || m.kind === "link") && (m.poster || m.src)) {
        const src = m.poster || m.src;
        return `<button type="button" class="feed-media feed-media-compact" data-action="feed-expand" data-post="${esc(post.id)}">
          <img src="${esc(src)}" alt="" loading="lazy" />
          ${m.kind === "video" ? `<span class="feed-media-play" aria-hidden="true">▶</span>` : ""}
          ${m.kind === "link" ? `<span class="feed-media-badge">${esc(m.host || "link")}</span>` : ""}
        </button>`;
      }
      return mediaHtml(post);
    })();

    return `
      <article class="feed-card${active ? " is-active" : ""}${expanded ? " is-expanded" : ""}" data-feed-id="${esc(post.id)}" id="feed-card-${esc(post.id)}">
        <div class="feed-votes" aria-hidden="true">
          <span class="feed-vote-arrow">▲</span>
          <span class="feed-vote-score">${esc(scoreLabel(post.score))}</span>
          <span class="feed-vote-arrow dim">▼</span>
        </div>
        <div class="feed-main">
          <div class="feed-meta">
            <span class="feed-sub">r/${esc(post.subreddit || "?")}</span>
            <span class="feed-dot">·</span>
            <span class="feed-author">u/${esc(post.author || "[deleted]")}</span>
            ${when ? `<span class="feed-dot">·</span><span class="feed-when">${esc(when)}</span>` : ""}
            ${flair}
          </div>
          <h3 class="feed-title">
            <button type="button" class="feed-title-btn" data-action="feed-expand" data-post="${esc(post.id)}">${esc(post.title || "(untitled)")}</button>
          </h3>
          ${media}
          ${expanded ? bodyHtml(post) : (post.selftext ? `<p class="feed-body-preview">${esc(trunc(post.selftext, 160))}</p>` : "")}
          <div class="feed-actions">
            <span class="feed-comments">${Util.fmtNum(post.num_comments || 0)} comments</span>
            ${audienceBadge(post)}
            <button type="button" class="btn tiny" data-action="feed-plan" data-post="${esc(post.id)}">Where next</button>
            ${post.permalink ? `<a class="btn tiny ghost" href="${esc(post.permalink)}" target="_blank" rel="noopener">Reddit ↗</a>` : ""}
            ${!expanded ? `<button type="button" class="btn tiny ghost" data-action="feed-expand" data-post="${esc(post.id)}">Expand</button>` : ""}
          </div>
        </div>
      </article>`;
  }

  function paint() {
    let list = Dom.byId("feed-viewer-list");
    const body = document.querySelector("#feed-viewer [data-sidebar-body]");
    if (!list && body) {
      body.innerHTML = `<div id="feed-viewer-list" class="feed-list"></div>`;
      list = Dom.byId("feed-viewer-list");
    }
    const meta = Dom.byId("feed-viewer-meta");
    if (!list) return;
    if (!posts.length) {
      list.innerHTML = `<div class="empty plan-syn-empty"><strong>No posts to show</strong><p>Load communities or open Recommend first.</p></div>`;
      if (meta) meta.textContent = "";
      return;
    }
    if (meta) {
      meta.textContent = focusId
        ? `${posts.length} in this feed · focused`
        : `${posts.length} post${posts.length === 1 ? "" : "s"}`;
    }
    list.innerHTML = posts.map((p) => cardHtml(p, { expanded: p.id === focusId })).join("");
    if (focusId) {
      const card = Dom.byId("feed-card-" + focusId);
      const body = document.querySelector("#feed-viewer [data-sidebar-body]");
      if (card && body) {
        const scrollToFocus = () => {
          const top = card.offsetTop - Math.max(24, (body.clientHeight - card.offsetHeight) / 2);
          try {
            body.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
          } catch (_) {
            try { card.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (__) {}
          }
        };
        /* Wait for the mobile slide-up animation + layout before measuring. */
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            scrollToFocus();
            window.setTimeout(scrollToFocus, 260);
          });
        });
      }
    }
  }

  function ensureOpen(opts) {
    opts = opts || {};
    const el = Dom.byId(SIDEBAR_ID);
    if (!el || el.hidden) {
      if (window.Sidebar) {
        Sidebar.open({
          id: SIDEBAR_ID,
          onClose: () => {
            focusId = null;
          },
        });
      } else if (el) {
        el.hidden = false;
        document.body.classList.add("sidebar-open");
      }
    }
    const titleEl = el && el.querySelector("[data-sidebar-title]");
    if (titleEl) titleEl.textContent = opts.title || title;
    const subEl = el && el.querySelector("[data-sidebar-subtitle]");
    if (subEl) {
      subEl.textContent = opts.subtitle || "";
      subEl.hidden = !opts.subtitle;
    }
  }

  /* Open a feed of posts. opts.focusId scrolls/expands one card. */
  View.open = function (list, opts) {
    opts = opts || {};
    posts = (list || []).filter((p) => p && p.id && !p.syndicated);
    focusId = opts.focusId || (posts[0] && posts[0].id) || null;
    title = opts.title || "Feed";
    ensureOpen({ title: title, subtitle: opts.subtitle || "" });
    paint();
  };

  View.openPost = function (post, opts) {
    opts = opts || {};
    if (!post) return;
    let list = opts.posts;
    if (!list || !list.length) {
      const all = ((window.AppState && AppState.posts) || []).filter((p) => p && !p.syndicated);
      /* Prefer same-sub neighbours so the feed feels local. */
      const home = String(post.subreddit || "").toLowerCase();
      const same = all.filter((p) => String(p.subreddit || "").toLowerCase() === home);
      list = same.length >= 2 ? same : all;
      if (!list.some((p) => p.id === post.id)) list = [post].concat(list);
    }
    View.open(list, {
      focusId: post.id,
      title: opts.title || ("r/" + (post.subreddit || "posts")),
      subtitle: opts.subtitle || trunc(post.title || "", 60),
    });
  };

  View.close = function () {
    if (window.Sidebar) Sidebar.close();
  };

  View.bind = function () {
    Dom.delegate(document, "click", '[data-action="feed-expand"]', (e, el) => {
      const id = el.dataset.post;
      if (!id) return;
      focusId = id;
      paint();
    });
    Dom.delegate(document, "click", '[data-action="feed-plan"]', (e, el) => {
      const id = el.dataset.post;
      const post = posts.find((p) => p && p.id === id)
        || (((window.AppState && AppState.posts) || []).find((p) => p && p.id === id));
      if (!post || !window.FocusView) return;
      View.close();
      FocusView.focusPost(post);
    });
    Dom.delegate(document, "click", '[data-action="feed-media"]', (e, el) => {
      if (window.App && typeof App.openMediaPreview === "function") {
        App.openMediaPreview(el.dataset.src, el.dataset.alt || "");
      } else if (el.dataset.src) {
        window.open(el.dataset.src, "_blank", "noopener");
      }
    });
    Dom.delegate(document, "click", '[data-action="open-feed"]', (e, el) => {
      const scope = el.dataset.feedScope || "active";
      let list = ((window.AppState && AppState.posts) || []).filter((p) => p && !p.syndicated);
      if (scope === "recommend" && window.RecommendView && RecommendView.candidatePosts) {
        list = RecommendView.candidatePosts(24);
      } else if (scope === "filtered" && window.App && App.filteredPosts) {
        list = App.filteredPosts();
      }
      View.open(list, {
        title: el.dataset.feedTitle || "Feed",
        subtitle: list.length ? `${list.length} posts` : "",
        focusId: el.dataset.focusId || null,
      });
    });
    Dom.delegate(document, "click", '[data-action="open-post-feed"]', (e, el) => {
      e.preventDefault();
      e.stopPropagation();
      const id = el.dataset.postId;
      if (!id) return;
      const post = ((window.AppState && AppState.posts) || []).find((p) => p && p.id === id);
      if (!post) return;
      let neighbors = null;
      if (window.App && App.filteredPosts) {
        const filtered = App.filteredPosts().filter((p) => p && !p.syndicated);
        if (filtered.some((p) => p.id === id)) neighbors = filtered;
      }
      View.openPost(post, {
        posts: neighbors || undefined,
        title: "r/" + (post.subreddit || "posts"),
      });
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => View.bind());
  } else {
    View.bind();
  }

  window.FeedView = View;
})();
