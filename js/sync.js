/* Cross-device session sync.
 *
 * The dashboard runs entirely client-side, so there's no server we can
 * push state to. But we *can* serialise the user's state into:
 *   - a base64url string short enough to fit in a URL fragment, OR
 *   - a JSON file the user can download / paste / AirDrop / Handoff.
 *
 * The URL fragment never hits the network (browsers strip the # before
 * the GET) so even sensitive paste lists stay private to the user.
 *
 * Synced state covers:
 *   - all saved Campaigns
 *   - knownSubs / activeSubs (the chip set)
 *   - activeSpheres (manual picker selections on Discover)
 *   - listing / time / limit prefs
 *   - the proxy choice and discoverStrict toggle
 *   - the timeline mode + window
 * Per-device viewing state (table sort, page index, search query) is
 * deliberately NOT synced — it'd be more annoying than useful.
 */
(function () {
  const Sync = {};

  /* Bump this when the payload shape changes incompatibly so older
   * clients can decline gracefully. */
  Sync.VERSION = 1;

  /* ----------------------------- collect ----------------------------- */

  Sync.collectPayload = function () {
    const safe = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
    const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };

    const campaigns = (typeof Campaigns !== "undefined" && Campaigns.list) ? Campaigns.list() : [];
    let knownSubs = [], activeSubs = [], activeSpheres = [];
    try { knownSubs = JSON.parse(safe("rj.subs") || "[]"); } catch (_) {}
    try { activeSubs = JSON.parse(safe("rj.active") || "[]"); } catch (_) {}
    try { activeSpheres = JSON.parse(safe("rj.activeSpheres") || "[]"); } catch (_) {}

    return {
      v: Sync.VERSION,
      ts: Date.now(),
      app: "old-reddit-json-reporter",
      campaigns: Array.isArray(campaigns) ? campaigns : [],
      subs: {
        known: Array.isArray(knownSubs) ? knownSubs : [],
        active: Array.isArray(activeSubs) ? activeSubs : [],
      },
      activeSpheres: Array.isArray(activeSpheres) ? activeSpheres : [],
      prefs: {
        listing: safe("rj.listing") || "hot",
        time: safe("rj.time") || "week",
        limit: num(safe("rj.limit")) || 100,
        transport: safe("rj.transport") || "auto",
      },
    };
  };

  /* ----------------------------- encode ------------------------------ */

  /* base64url so the result fits cleanly inside a URL fragment.
   * Handles arbitrary unicode in campaign names via the
   * %-encoded-bytes -> binary-string trick. */
  function toBase64Url(str) {
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function fromBase64Url(s) {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    return decodeURIComponent(escape(atob(b64)));
  }

  Sync.encode = function (payload) {
    const json = JSON.stringify(payload);
    return toBase64Url(json);
  };

  Sync.decode = function (encoded) {
    if (!encoded) return null;
    let json;
    try { json = fromBase64Url(String(encoded).trim()); }
    catch (_) { return null; }
    try {
      const parsed = JSON.parse(json);
      if (parsed && parsed.app === "old-reddit-json-reporter") return parsed;
    } catch (_) {}
    return null;
  };

  Sync.toShareUrl = function () {
    const payload = Sync.collectPayload();
    const encoded = Sync.encode(payload);
    /* Use location.origin + pathname so the share link works for both
     * the live Pages URL and a local server. Strip any existing hash. */
    const base = (typeof location !== "undefined")
      ? location.origin + location.pathname
      : "";
    return base + "#session=" + encoded;
  };

  /* ----------------------------- apply ------------------------------- */

  /* Apply a decoded payload back into localStorage + Campaigns.
   *
   * options.mode: "replace" (default) wipes existing state first;
   *               "merge"  keeps existing campaigns, only adds new ones,
   *                        and unions sub lists / spheres.
   *
   * Returns a stats object describing what happened.
   */
  Sync.applyPayload = function (payload, options) {
    options = options || {};
    const mode = options.mode === "merge" ? "merge" : "replace";
    if (!payload || payload.app !== "old-reddit-json-reporter") {
      throw new Error("Not a Reddit Campaign Reporter session payload");
    }

    let campaignsAdded = 0, campaignsKept = 0, campaignsReplaced = 0;
    if (typeof Campaigns !== "undefined" && Array.isArray(payload.campaigns)) {
      if (mode === "replace") {
        /* Wipe and re-add. Preserves the original ids from the payload
         * so links / references in chats / etc. keep matching. */
        const existing = Campaigns.list ? Campaigns.list() : [];
        for (const c of existing) {
          if (Campaigns.remove) Campaigns.remove(c.id);
        }
        campaignsReplaced = existing.length;
        for (const c of payload.campaigns) {
          /* Use the storage's import path if available; otherwise fall
           * back to add(). importJson lets us preserve the full payload
           * including ids + createdAt timestamps. */
          if (Campaigns.importJson) {
            Campaigns.importJson(JSON.stringify(payload.campaigns));
            campaignsAdded = payload.campaigns.length;
            break;
          } else if (Campaigns.add) {
            Campaigns.add({
              name: c.name,
              goalScore: c.goalScore,
              goalComments: c.goalComments,
              postIds: c.postIds || [],
            });
            campaignsAdded++;
          }
        }
      } else {
        /* Merge: skip campaigns whose id OR (name, postIds) signature
         * already exists. Add the rest. */
        const existing = Campaigns.list ? Campaigns.list() : [];
        const seenIds = new Set(existing.map((c) => c.id));
        const seenSig = new Set(existing.map((c) =>
          c.name + "|" + (c.postIds || []).slice().sort().join(",")));
        campaignsKept = existing.length;
        for (const c of payload.campaigns) {
          const sig = c.name + "|" + (c.postIds || []).slice().sort().join(",");
          if (seenIds.has(c.id) || seenSig.has(sig)) continue;
          if (Campaigns.add) {
            Campaigns.add({
              name: c.name,
              goalScore: c.goalScore,
              goalComments: c.goalComments,
              postIds: c.postIds || [],
            });
            campaignsAdded++;
          }
        }
      }
    }

    /* Subs and spheres go through localStorage directly so the next
     * loadPersisted() picks them up cleanly. */
    function writeStringList(key, current, incoming) {
      try {
        const merged = mode === "merge"
          ? Array.from(new Set([...(current || []), ...(incoming || [])]))
          : (incoming || []);
        localStorage.setItem(key, JSON.stringify(merged));
      } catch (_) {}
    }
    let curKnown = [], curActive = [], curSpheres = [];
    try { curKnown = JSON.parse(localStorage.getItem("rj.subs") || "[]"); } catch (_) {}
    try { curActive = JSON.parse(localStorage.getItem("rj.active") || "[]"); } catch (_) {}
    try { curSpheres = JSON.parse(localStorage.getItem("rj.activeSpheres") || "[]"); } catch (_) {}

    const sIn = payload.subs || {};
    writeStringList("rj.subs", curKnown, sIn.known);
    writeStringList("rj.active", curActive, sIn.active);
    writeStringList("rj.activeSpheres", curSpheres, payload.activeSpheres);

    /* Prefs: replace mode overrides; merge mode only fills in missing keys. */
    const prefs = payload.prefs || {};
    function pref(key, value) {
      if (value == null) return;
      try {
        if (mode === "replace") localStorage.setItem(key, String(value));
        else if (!localStorage.getItem(key)) localStorage.setItem(key, String(value));
      } catch (_) {}
    }
    pref("rj.listing", prefs.listing);
    pref("rj.time", prefs.time);
    pref("rj.limit", prefs.limit);
    pref("rj.transport", prefs.transport);

    return {
      mode,
      campaignsAdded,
      campaignsReplaced,
      campaignsKept,
      knownSubs: (sIn.known || []).length,
      activeSubs: (sIn.active || []).length,
      activeSpheres: (payload.activeSpheres || []).length,
      payloadAge: payload.ts ? Math.max(0, Date.now() - payload.ts) : null,
    };
  };

  /* Detect a session payload in the current URL fragment. Returns
   * { encoded, payload } or null. The fragment is left intact for the
   * caller to clear after the user accepts/rejects. */
  Sync.parseHashPayload = function () {
    if (typeof location === "undefined") return null;
    const hash = location.hash || "";
    const m = hash.match(/(?:^|[#&])session=([^&]+)/);
    if (!m) return null;
    const encoded = m[1];
    const payload = Sync.decode(encoded);
    if (!payload) return null;
    return { encoded, payload };
  };

  /* Approximate length-on-the-clipboard so we can warn the user when
   * a session is too big to be a comfortable URL. */
  Sync.estimateSize = function () {
    try { return Sync.encode(Sync.collectPayload()).length; } catch (_) { return 0; }
  };

  if (typeof window !== "undefined") window.Sync = Sync;
  if (typeof module !== "undefined" && module.exports) module.exports = Sync;
})();
