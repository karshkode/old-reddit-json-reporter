/* =====================================================================
 * COMMUNITY POSTING RULES
 * ---------------------------------------------------------------------
 * Where-next used to match on subject alone. That is half an answer:
 * r/politics will remove a self-post about the same story it would
 * frontpage as a fresh article, and r/WhitePeopleTwitter will remove
 * anything that is not a social-media screenshot. Recommending either
 * for the wrong kind of post is recommending a removal.
 *
 * This module has two jobs:
 *
 *   1. Classify a post into a kind the rules can speak about
 *      (self / link / image / video / gallery / social screenshot),
 *      and name the platform when the image came from one.
 *   2. Hold a curated map of communities whose rules reject whole
 *      kinds of posts, so a ranking can refuse them — or say why —
 *      instead of treating every room as open to every format.
 *
 * The catalog is editorial, not scraped. Reddit's about.json does not
 * encode "Twitter screenshots only" or "no reposts of this URL", and
 * those are exactly the rules that decide whether a cross-post lands
 * or gets taken down. Entries cover the progressive-sphere communities
 * this tool already recommends; unknown subs are treated as open.
 * ===================================================================== */
(function () {
  const Rules = {};

  /* ------------------------------------------------------------------
   * POST KIND
   * ------------------------------------------------------------------ */

  const IMAGE_HOSTS = new Set([
    "i.redd.it", "preview.redd.it", "i.imgur.com", "imgur.com",
    "i.ibb.co", "pbs.twimg.com", "media.tenor.com", "media.giphy.com",
  ]);
  const VIDEO_HOSTS = new Set([
    "v.redd.it", "youtube.com", "www.youtube.com", "youtu.be",
    "m.youtube.com", "vimeo.com", "streamable.com", "tiktok.com",
    "www.tiktok.com",
  ]);
  /* Hosts that are user-uploaded / social clips, not an editorial news
   * desk. r/politics allows "videos" in the abstract but removes Reddit
   * native clips, TikToks and the rest — those are UGC, and UGC is on
   * the disallowed list. */
  const UGC_VIDEO_HOSTS = new Set([
    "v.redd.it", "reddit.com", "www.reddit.com", "old.reddit.com",
    "np.reddit.com", "tiktok.com", "www.tiktok.com", "vm.tiktok.com",
    "streamable.com", "clips.twitch.tv", "twitch.tv", "www.twitch.tv",
  ]);
  /* Hostnames that mean the linked thing is a social post, not an
   * article — used both to classify the link itself and to recognise
   * a screenshot that was rehosted on imgur or i.redd.it. */
  const SOCIAL_HOSTS = {
    "twitter.com": "twitter",
    "www.twitter.com": "twitter",
    "mobile.twitter.com": "twitter",
    "x.com": "twitter",
    "www.x.com": "twitter",
    "pbs.twimg.com": "twitter",
    "pic.twitter.com": "twitter",
    "bsky.app": "bluesky",
    "www.bsky.app": "bluesky",
    "cdn.bsky.app": "bluesky",
    "threads.net": "threads",
    "www.threads.net": "threads",
    "instagram.com": "instagram",
    "www.instagram.com": "instagram",
    "cdninstagram.com": "instagram",
    "facebook.com": "facebook",
    "www.facebook.com": "facebook",
    "fb.com": "facebook",
    "tiktok.com": "tiktok",
    "www.tiktok.com": "tiktok",
    "tumblr.com": "tumblr",
    "www.tumblr.com": "tumblr",
  };

  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i;

  function hostOf(url) {
    if (!url) return "";
    try { return String(new URL(url).hostname || "").toLowerCase(); }
    catch (_) {
      const m = String(url).match(/^(?:https?:\/\/)?([^\/?#]+)/i);
      return m ? m[1].toLowerCase() : "";
    }
  }

  function platformOf(host, provider) {
    if (host && SOCIAL_HOSTS[host]) return SOCIAL_HOSTS[host];
    const p = String(provider || "").toLowerCase();
    if (/twitter|x\.com/.test(p)) return "twitter";
    if (/bluesky|bsky/.test(p)) return "bluesky";
    if (/threads/.test(p)) return "threads";
    if (/instagram/.test(p)) return "instagram";
    if (/facebook|fb\.com/.test(p)) return "facebook";
    if (/tiktok/.test(p)) return "tiktok";
    if (/tumblr/.test(p)) return "tumblr";
    return null;
  }

  /* What kind of thing this post is, for rule matching.
   *
   * Order matters: a Reddit gallery is also "not a self-post", and a
   * tweet screenshot rehosted on i.redd.it is an image first and a
   * social screenshot second. Callers that care about platform look
   * at `.platform` / `.social` rather than inventing a fifth kind. */
  Rules.classify = function (post) {
    if (!post) return { kind: "unknown", platform: null, social: false, domain: "", label: "unknown" };

    const domain = String(post.domain || hostOf(post.url) || "").toLowerCase().replace(/^self\./, "self.");
    const host = hostOf(post.url) || domain;
    const platform = platformOf(host, post.media_provider);
    const url = String(post.url || "");
    /* Community flair is often more honest than the URL. A native Reddit
     * video still has a reddit.com permalink in some adapters, but the
     * flair says "Video" — that is the clue Where-next was missing. */
    const flair = String(post.flair || post.link_flair_text || "").toLowerCase();
    const hint = String(post.post_hint || "").toLowerCase();
    const flairSaysVideo = /\bvideos?\b|\bclips?\b/.test(flair);
    const hintSaysVideo = /video/.test(hint);

    if (post.is_self && !flairSaysVideo && !post.is_video) {
      return { kind: "self", platform: null, social: false, domain: domain, label: "text post" };
    }
    if (post.is_gallery) {
      return { kind: "gallery", platform: platform, social: !!platform, domain: domain, label: "image gallery" };
    }
    if (post.is_video || hintSaysVideo || flairSaysVideo
        || VIDEO_HOSTS.has(host) || /youtube|vimeo|streamable|tiktok/.test(host)
        || UGC_VIDEO_HOSTS.has(host)) {
      return {
        kind: "video",
        platform: platform || (/youtube|youtu\.be/.test(host) ? "youtube" : null),
        social: !!platform,
        domain: domain,
        ugc: UGC_VIDEO_HOSTS.has(host) || host.indexOf("redd.it") !== -1 || flairSaysVideo && (!host || /reddit/.test(host)),
        label: "video",
      };
    }

    const looksImage = IMAGE_HOSTS.has(host) || IMAGE_EXT.test(url)
      || (post.thumbnail && /^https?:/.test(post.thumbnail) && IMAGE_EXT.test(post.thumbnail));
    if (looksImage) {
      return {
        kind: "image",
        platform: platform,
        social: !!platform,
        domain: domain,
        label: platform ? platform + " screenshot" : "image",
      };
    }

    /* A bare link to twitter.com/status/... is a social link, not an
       article — communities that want screenshots still reject it, but
       the label has to say what it is. */
    if (platform) {
      return { kind: "link", platform: platform, social: true, domain: domain, label: platform + " link" };
    }

    return { kind: "link", platform: null, social: false, domain: domain, label: "link / article" };
  };

  Rules.kindLabel = function (kind) {
    return ({
      self: "text post",
      link: "link / article",
      image: "image",
      video: "video",
      gallery: "image gallery",
      unknown: "unknown",
    })[kind] || kind;
  };

  /* ------------------------------------------------------------------
   * RULE CATALOG
   * ------------------------------------------------------------------ */

  /* Shape of an entry:
   *
   *   allows        kinds this community will take. Omit for "anything".
   *   requires      extra constraints beyond kind:
   *                   "unique_link"        URL must not already be there
   *                   "editorial_source"  news-desk link/video only —
   *                                       Reddit clips, TikTok and other
   *                                       UGC fail even when video is
   *                                       otherwise allowed
   *                   "social_screenshot"  image of a social post
   *                   "twitter_screenshot" specifically Twitter/X
   *   platforms     when requires social_screenshot, which platforms
   *                   count. Empty / omitted = any of the known ones.
   *   note          one line for the UI
   *
   * A community not in this map is treated as open. That is deliberate:
   * inventing rules for rooms we have not checked is how good posts
   * get silenced. */
  const CATALOG = {
    /* --- news / politics: articles, usually unique --- */
    politics: {
      allows: ["link", "video"],
      requires: ["unique_link", "editorial_source"],
      note: "US-politics news from approved outlets only — articles or news-desk video. Reddit clips, TikTok and other UGC are removed; titles must match the source headline.",
    },
    news: {
      allows: ["link", "video"],
      requires: ["unique_link", "editorial_source"],
      note: "News articles or news-desk video only; Reddit/social clips and URL reposts are removed.",
    },
    worldnews: {
      allows: ["link"],
      requires: ["unique_link"],
      note: "Link posts only — no text posts, images or video — and the URL must be new to the sub.",
    },
    inthenews: {
      allows: ["link"],
      requires: ["unique_link"],
      note: "News links only; the article must not already be on the sub.",
    },
    qualitynews: {
      allows: ["link"],
      requires: ["unique_link"],
      note: "Quality news links only; duplicates are removed.",
    },
    neutralnews: {
      allows: ["link"],
      requires: ["unique_link"],
      note: "Neutral news links only; the URL must be new to the sub.",
    },
    truereddit: {
      allows: ["link"],
      note: "In-depth articles only — no images, text posts or short takes.",
    },
    politicsdiscussion: {
      allows: ["self"],
      note: "Text posts for discussion; link dumps belong in r/politics.",
    },
    politicaldiscussion: {
      allows: ["self"],
      note: "Text posts for discussion; link dumps belong elsewhere.",
    },
    ask_politics: {
      allows: ["self"],
      note: "Questions as text posts only.",
    },
    askapolitics: {
      allows: ["self"],
      note: "Questions as text posts only.",
    },

    /* --- social-screenshot communities --- */
    blackpeopletwitter: {
      allows: ["image", "gallery"],
      requires: ["social_screenshot"],
      platforms: ["twitter", "bluesky", "threads", "instagram", "facebook", "tumblr"],
      note: "Screenshots of Black people being funny or insightful on social media. Not articles, text posts, or image macros.",
    },
    whitepeopletwitter: {
      allows: ["image", "gallery"],
      requires: ["social_screenshot"],
      platforms: ["twitter", "bluesky", "threads"],
      note: "Screenshots of tweets (and close cousins). Articles and text posts are removed.",
    },
    scottishpeopletwitter: {
      allows: ["image", "gallery"],
      requires: ["social_screenshot"],
      platforms: ["twitter", "bluesky", "threads"],
      note: "Social-media screenshots only.",
    },
    latinopeopletwitter: {
      allows: ["image", "gallery"],
      requires: ["social_screenshot"],
      platforms: ["twitter", "bluesky", "threads", "instagram"],
      note: "Social-media screenshots only.",
    },
    bipoconlytwitter: {
      allows: ["image", "gallery"],
      requires: ["social_screenshot"],
      platforms: ["twitter", "bluesky", "threads"],
      note: "Social-media screenshots only.",
    },
    toiletpaperusa: {
      allows: ["image", "gallery", "link"],
      note: "Mostly screenshots and political images; long text posts land poorly.",
    },
    forwardeffect: {
      allows: ["image", "gallery", "link"],
      note: "Image-led political posts; text-only rarely survives.",
    },

    /* --- image / meme-shaped progressive rooms --- */
    latestagecapitalism: {
      allows: ["link", "image", "gallery"],
      note: "Links and images (macros, screenshots, articles). Native Reddit video and clips are a poor fit and often removed.",
    },
    aboringdystopia: {
      allows: ["link", "image", "gallery"],
      note: "Links and images of dystopian mundanity; video clips and text-only essays belong elsewhere.",
    },
    orphancrushingmachine: {
      allows: ["link", "image", "gallery"],
      note: "Links and images; text posts are a poor fit.",
    },

    /* --- discussion / self-post rooms --- */
    askliberal: {
      allows: ["self"],
      note: "Questions as text posts only.",
    },
    askaconservative: {
      allows: ["self"],
      note: "Questions as text posts only.",
    },
    askasocialist: {
      allows: ["self"],
      note: "Questions as text posts only.",
    },
    socialism_101: {
      allows: ["self"],
      note: "Questions and explanations as text posts; news links belong in r/socialism.",
    },
    anarchy101: {
      allows: ["self"],
      note: "Questions as text posts only.",
    },
    changemyview: {
      allows: ["self"],
      note: "CMV must be a text post in the required format.",
    },
    explainlikeimfive: {
      allows: ["self"],
      note: "ELI5 questions as text posts only.",
    },
    nostupidquestions: {
      allows: ["self"],
      note: "Questions as text posts only.",
    },
    self: {
      allows: ["self"],
      note: "Text posts only.",
    },
    offmychest: {
      allows: ["self"],
      note: "Text posts only.",
    },
    trueoffmychest: {
      allows: ["self"],
      note: "Text posts only.",
    },
    relationship_advice: {
      allows: ["self"],
      note: "Text posts only.",
    },
    advice: {
      allows: ["self"],
      note: "Text posts only.",
    },

    /* --- work / labor: mixed but often text --- */
    antiwork: {
      note: "Text, images and links all common — no hard format gate.",
    },
    workreform: {
      note: "Text, images and links all common — no hard format gate.",
    },
    jobs: {
      allows: ["self"],
      note: "Text posts about jobs; link dumps are removed.",
    },
    careers: {
      allows: ["self"],
      note: "Text posts only.",
    },
    cscareerquestions: {
      allows: ["self"],
      note: "Text posts only.",
    },

    /* --- science / niche link aggregators --- */
    technology: {
      allows: ["link"],
      requires: ["unique_link"],
      note: "Technology news links only; the URL must be new to the sub.",
    },
    science: {
      allows: ["link"],
      requires: ["unique_link"],
      note: "Peer-reviewed science links; text posts and images are removed.",
    },
    space: {
      allows: ["link", "image", "video"],
      note: "Links, images and video; discussion posts go in the weekly threads.",
    },
  };

  Rules.catalog = CATALOG;

  Rules.forSub = function (name) {
    const key = String(name || "").toLowerCase();
    return CATALOG[key] || null;
  };

  /* ------------------------------------------------------------------
   * MATCHING
   * ------------------------------------------------------------------ */

  /* Does this post already exist in this community, by URL?
   *
   * Used for unique_link. Only looks at what is loaded — a miss means
   * "not in your inventory", not "definitely never posted". Prefer
   * Rules.findPostedLink when the archive can be asked. */
  Rules.alreadyPosted = function (post, sub, posts) {
    const urls = linkKeys(post);
    if (!urls.length) return null;
    const key = String(sub || "").toLowerCase();
    const selfId = post && post.id ? String(post.id).replace(/^t3_/, "") : "";
    const list = posts || (window.AppState && AppState.postsForSub && AppState.postsForSub(key)) || [];
    for (const other of list) {
      if (!other) continue;
      const otherId = String(other.id || "").replace(/^t3_/, "");
      if (selfId && otherId === selfId) continue;
      if (String(other.subreddit || "").toLowerCase() !== key) continue;
      if (other.is_self) continue;
      const otherKeys = linkKeys(other);
      if (otherKeys.some((u) => urls.indexOf(u) !== -1)) return other;
    }
    return null;
  };

  function linkKeys(post) {
    if (!post || post.is_self) return [];
    const out = [];
    const seen = new Set();
    const push = (u) => {
      const s = String(u || "").trim();
      if (s.length < 12 || seen.has(s)) return;
      seen.add(s);
      out.push(s);
    };
    push(post.url_canonical || "");
    push(post.url || "");
    if (window.Reddit && Reddit.canonicalizeUrl && post.url) {
      try { push(Reddit.canonicalizeUrl(post.url)); } catch (_) {}
    }
    return out;
  }

  /* Local inventory first, then the Arctic Shift archive for that
   * subreddit. Returns { post, source: "local"|"archive" } or null.
   * Best-effort: archive failures are treated as "not found". */
  Rules.findPostedLink = async function (post, sub, opts) {
    opts = opts || {};
    const local = Rules.alreadyPosted(post, sub, opts.posts);
    if (local) return { post: local, source: "local" };

    const urls = linkKeys(post);
    if (!urls.length) return null;
    if (!window.Archive || typeof Archive.searchByUrl !== "function") return null;
    if (window.Demo && Demo.isActive && Demo.isActive()) return null;

    const key = String(sub || "").toLowerCase();
    const selfId = post && post.id ? String(post.id).replace(/^t3_/, "") : "";
    for (const url of urls) {
      let hits = [];
      try {
        hits = await Archive.searchByUrl(url, {
          subreddit: key,
          limit: opts.limit || 10,
          signal: opts.signal,
        });
      } catch (err) {
        console.warn(`[rules] archive url search r/${key}:`, err && err.message);
        continue;
      }
      for (const hit of hits || []) {
        if (!hit) continue;
        const hitId = String(hit.id || "").replace(/^t3_/, "");
        if (selfId && hitId === selfId) continue;
        if (String(hit.subreddit || "").toLowerCase() !== key) continue;
        if (hit.is_self) continue;
        return { post: hit, source: "archive" };
      }
    }
    return null;
  };

  /* Evaluate one community against one post.
   *
   * Returns:
   *   ok        true when the post clears every rule we know
   *   hard      true when a known rule forbids this kind outright
   *   reasons   short strings suitable for a badge or a sentence
   *   rule      the catalog entry (or null)
   *   kind      Rules.classify(post)
   *   duplicate the existing post, when unique_link failed
   */
  Rules.evaluate = function (post, sub, opts) {
    opts = opts || {};
    const kind = Rules.classify(post);
    const rule = Rules.forSub(sub);
    const out = {
      ok: true,
      hard: false,
      reasons: [],
      rule: rule,
      kind: kind,
      duplicate: null,
    };

    if (!rule) return out;

    if (rule.allows && rule.allows.length) {
      if (rule.allows.indexOf(kind.kind) === -1) {
        out.ok = false;
        out.hard = true;
        const want = rule.allows.map(Rules.kindLabel).join(" or ");
        out.reasons.push(`takes ${want}, not ${kind.label}`);
      }
    }

    const reqs = rule.requires || [];
    for (const req of reqs) {
      if (req === "social_screenshot") {
        const platforms = rule.platforms || null;
        const platformOk = kind.social && kind.platform
          && (!platforms || platforms.indexOf(kind.platform) !== -1);
        /* An image with no detectable platform is a soft no: it might
           still be a tweet screenshot rehosted somewhere we do not
           recognise, so refuse to hard-block and say what is missing. */
        if (kind.kind !== "image" && kind.kind !== "gallery") {
          out.ok = false;
          out.hard = true;
          out.reasons.push("needs a social-media screenshot");
        } else if (!platformOk) {
          out.ok = false;
          out.hard = !!(kind.platform); /* known wrong platform = hard */
          const want = (platforms || ["twitter"]).join("/");
          out.reasons.push(kind.platform
            ? `wants ${want}, this looks like ${kind.platform}`
            : `needs a ${want} screenshot`);
        }
      } else if (req === "twitter_screenshot") {
        if (kind.kind !== "image" && kind.kind !== "gallery") {
          out.ok = false;
          out.hard = true;
          out.reasons.push("needs a Twitter/X screenshot");
        } else if (kind.platform !== "twitter") {
          out.ok = false;
          out.hard = !!kind.platform;
          out.reasons.push(kind.platform
            ? `wants Twitter/X, this looks like ${kind.platform}`
            : "needs a Twitter/X screenshot");
        }
      } else if (req === "unique_link") {
        if (kind.kind === "link" || kind.kind === "video") {
          const dup = Rules.alreadyPosted(post, sub, opts.posts);
          if (dup) {
            out.ok = false;
            out.hard = true;
            out.duplicate = dup;
            out.reasons.push("this link is already on the sub");
          }
        }
      } else if (req === "editorial_source") {
        /* r/politics-shaped rooms allow "video" in the abstract, but
         * only from news desks on the whitelist. A flair that says
         * Video on a v.redd.it clip is exactly what they remove. */
        const host = (hostOf(post.url) || kind.domain || "").toLowerCase();
        const ugcHost = !host
          || UGC_VIDEO_HOSTS.has(host)
          || /\.redd\.it$/.test(host)
          || /(?:^|\.)reddit\.com$/.test(host)
          || !!kind.ugc;
        if (kind.kind === "video") {
          if (ugcHost) {
            out.ok = false;
            out.hard = true;
            out.reasons.push("needs a news article, not a Reddit/social clip");
          } else if (/youtube|youtu\.be|vimeo|streamable/.test(host)) {
            /* A few YouTube news channels are approved; most are not.
             * Soft-fail so the row stays visible with a warning. */
            out.ok = false;
            out.hard = false;
            out.reasons.push("video must be from an approved news outlet");
          }
        } else if (kind.kind === "link" && (ugcHost && host || SOCIAL_HOSTS[host])) {
          out.ok = false;
          out.hard = true;
          out.reasons.push(SOCIAL_HOSTS[host]
            ? "social media links are not allowed"
            : "needs a news article, not a Reddit/social clip");
        }
      }
    }

    return out;
  };

  /* Short badge text for a passing / failing rule check. */
  Rules.badge = function (verdict) {
    if (!verdict) return "";
    if (verdict.ok) {
      if (verdict.rule && verdict.rule.requires && verdict.rule.requires.length) {
        return "fits the rules";
      }
      return "";
    }
    return verdict.reasons[0] || "against the rules";
  };

  Rules.noteFor = function (sub) {
    const rule = Rules.forSub(sub);
    return rule && rule.note || "";
  };

  window.Rules = Rules;
})();
