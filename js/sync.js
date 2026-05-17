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
 *   - the proxy choice
 * Per-device viewing state (table sort, page index, search query) is
 * deliberately NOT synced — it'd be more annoying than useful.
 *
 * URL formats supported:
 *   #s=<base64url>       NEW. Compact positional array; if the bytes
 *                        decode with the gzip magic header (0x1f 0x8b)
 *                        we DecompressionStream-gunzip them first.
 *                        Typical Signal-sized result for a normal
 *                        session: 150-300 chars.
 *   #session=<base64url> LEGACY. Verbose key-named JSON. Decoder still
 *                        understands these so existing shared links
 *                        keep working.
 */
(function () {
  const Sync = {};

  /* Compact format version. Bump when the schema changes
   * incompatibly so older clients can decline gracefully. */
  Sync.VERSION = 2;

  /* Enum tables for the compact format. Keep these append-only and
   * never reorder — index positions are part of the wire format. */
  const LISTINGS   = ["hot", "new", "top", "rising", "controversial"];
  const TIMES      = ["hour", "day", "week", "month", "year", "all"];
  const TRANSPORTS = ["auto", "codetabs", "allorigins", "corsproxy", "isomorphic", "direct"];

  function idx(arr, v, fallback) {
    const i = arr.indexOf(v);
    return i < 0 ? (fallback || 0) : i;
  }

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

  /* ----------------------------- compact ----------------------------- */

  /* Verbose payload -> tightly-packed positional array.
   *
   * Every byte saved here is a byte that doesn't need to be gzipped
   * later, and the format reads sensibly even WITHOUT gzip support
   * (Safari < 16.4 etc.) because we drop redundant fields and use
   * enum indexes for prefs.
   *
   * Layout (ALL POSITIONS ARE PART OF THE WIRE FORMAT — never reorder):
   *   [0] version (always 2 for this format)
   *   [1] ts (number, milliseconds)
   *   [2] campaigns: [[name, [postIds], goalScore?, goalComments?], ...]
   *       trailing zero goals are omitted to save bytes
   *   [3] subs: [[known], [active]] — if active === known we send
   *       just [[known]] which is ~50% smaller for the common case
   *       where every known sub is active
   *   [4] activeSpheres: [string, ...]
   *   [5] prefs: [listingIdx, timeIdx, limit, transportIdx]
   */
  function sameStringList(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const sa = a.slice().sort();
    const sb = b.slice().sort();
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
  }
  function compactify(payload) {
    const campaigns = (payload.campaigns || []).map((c) => {
      const arr = [String(c.name || ""), (c.postIds || []).map(String)];
      const gs = Number(c.goalScore) || 0;
      const gc = Number(c.goalComments) || 0;
      /* Push only as many trailing fields as needed — JSON arrays
       * encode shorter when they have fewer elements. */
      if (gs || gc) arr.push(gs);
      if (gc) arr.push(gc);
      return arr;
    });
    const subs = payload.subs || {};
    const known = Array.isArray(subs.known) ? subs.known : [];
    const active = Array.isArray(subs.active) ? subs.active : known;
    const subsArr = sameStringList(known, active) ? [known] : [known, active];
    const prefs = payload.prefs || {};
    const prefsArr = [
      idx(LISTINGS, prefs.listing || "hot"),
      idx(TIMES, prefs.time || "week"),
      Number(prefs.limit) || 100,
      idx(TRANSPORTS, prefs.transport || "auto"),
    ];
    return [
      2,
      Number(payload.ts) || Date.now(),
      campaigns,
      subsArr,
      payload.activeSpheres || [],
      prefsArr,
    ];
  }
  function decompactify(arr) {
    if (!Array.isArray(arr) || arr.length < 6 || arr[0] !== 2) return null;
    /* CRITICAL: Number(), not `| 0`. JavaScript's bitwise OR truncates
     * to a 32-bit signed integer. Date.now() is ~1.7e12 (way above the
     * 32-bit max of ~2.1e9), so `ts | 0` lops off the high bits and
     * wraps the timestamp back into early 1970. The "Found a shared
     * session" import banner then read e.g. '1/11/1970, 10:27:33 AM'
     * even though the session was just saved seconds ago. */
    const ts = Number(arr[1]) || 0;
    const campaignsCompact = arr[2] || [];
    const subsArr = arr[3] || [];
    const spheres = arr[4] || [];
    const prefsArr = arr[5] || [];
    const campaigns = campaignsCompact.map((c) => ({
      name: String(c[0] || ""),
      postIds: Array.isArray(c[1]) ? c[1].map(String) : [],
      goalScore: Number(c[2]) || 0,
      goalComments: Number(c[3]) || 0,
    }));
    const known = (subsArr[0] || []).map(String);
    const active = subsArr.length > 1 ? (subsArr[1] || []).map(String) : known.slice();
    const prefs = {
      listing:   LISTINGS[prefsArr[0] | 0]   || "hot",
      time:      TIMES[prefsArr[1] | 0]      || "week",
      limit:     Number(prefsArr[2]) || 100,
      transport: TRANSPORTS[prefsArr[3] | 0] || "auto",
    };
    return {
      v: 2,
      ts: ts || Date.now(),
      app: "old-reddit-json-reporter",
      campaigns,
      subs: { known, active },
      activeSpheres: spheres,
      prefs,
    };
  }

  /* ----------------------- encode helpers ---------------------------- */

  function utf8Encode(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    /* Fallback: %-encode then convert to bytes. */
    const bin = unescape(encodeURIComponent(s));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8Decode(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(bin));
  }
  function bytesToBase64Url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function base64UrlToBytes(s) {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function gzipBytes(bytes) {
    if (typeof CompressionStream === "undefined") return null;
    try {
      const cs = new CompressionStream("gzip");
      const stream = new Blob([bytes]).stream().pipeThrough(cs);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (_) { return null; }
  }
  async function gunzipBytes(bytes) {
    if (typeof DecompressionStream === "undefined") return null;
    try {
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (_) { return null; }
  }

  /* Public encoder for the SHORT format. Always returns a Promise so
   * callers can `await` regardless of whether the browser has
   * CompressionStream — the gzip step is best-effort and silently
   * skipped on older Safari. */
  Sync.encodeShort = async function (payload) {
    const compact = compactify(payload);
    const json = JSON.stringify(compact);
    let bytes = utf8Encode(json);
    /* Try gzip. If it actually shrinks the payload, use it; if gzip
     * is unavailable or somehow produces LARGER output (rare for
     * structured JSON but possible for tiny payloads), keep the
     * uncompressed bytes — the decoder magic-byte sniffs both. */
    const gz = await gzipBytes(bytes);
    if (gz && gz.length < bytes.length) bytes = gz;
    return bytesToBase64Url(bytes);
  };

  Sync.decodeShort = async function (encoded) {
    if (!encoded) return null;
    let bytes;
    try { bytes = base64UrlToBytes(String(encoded).trim()); } catch (_) { return null; }
    /* gzip magic = 0x1f, 0x8b */
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const gunzipped = await gunzipBytes(bytes);
      if (!gunzipped) return null;
      bytes = gunzipped;
    }
    let str;
    try { str = utf8Decode(bytes); } catch (_) { return null; }
    let arr;
    try { arr = JSON.parse(str); } catch (_) { return null; }
    return decompactify(arr);
  };

  /* ------------------- legacy verbose encoder ------------------------ */

  /* Kept so old `#session=…` URLs (verbose key-named JSON, base64url)
   * still decode. We never USE this encoder for new share links —
   * the short one above always produces smaller output. */
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
    /* Legacy verbose encoder. Retained so callers that explicitly
     * want the long format (e.g. tests) can still reach it. */
    return toBase64Url(JSON.stringify(payload));
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

  /* ------------------------- share URL ------------------------------- */

  /* Build a share URL using the new short `#s=…` format. Async because
   * gzip via CompressionStream is async. The caller already lives in
   * an async click handler so this is a transparent change. */
  Sync.toShareUrl = async function () {
    const payload = Sync.collectPayload();
    const encoded = await Sync.encodeShort(payload);
    const base = (typeof location !== "undefined")
      ? location.origin + location.pathname
      : "";
    return base + "#s=" + encoded;
  };

  /* Returns { encoded, payload, format } where format is one of
   * "short" | "legacy" — useful for status messages. Async because
   * the short path may need DecompressionStream. */
  Sync.parseHashPayload = async function () {
    if (typeof location === "undefined") return null;
    const hash = location.hash || "";
    const mShort = hash.match(/(?:^|[#&])s=([^&]+)/);
    if (mShort) {
      const encoded = mShort[1];
      const payload = await Sync.decodeShort(encoded);
      if (payload) return { encoded, payload, format: "short" };
    }
    const mLegacy = hash.match(/(?:^|[#&])session=([^&]+)/);
    if (mLegacy) {
      const encoded = mLegacy[1];
      const payload = Sync.decode(encoded);
      if (payload) return { encoded, payload, format: "legacy" };
    }
    return null;
  };

  /* Try every known encoding when the user pastes raw text into the
   * import box. Order: short URL → legacy URL → bare base64 short →
   * bare base64 legacy → raw JSON. Async to support the gzipped
   * short format. */
  Sync.decodeFromAnyText = async function (raw) {
    raw = String(raw || "").trim();
    if (!raw) return null;
    const mShort = raw.match(/[#&?]s=([^&\s]+)/);
    if (mShort) {
      const p = await Sync.decodeShort(mShort[1]);
      if (p) return { payload: p, format: "short" };
    }
    const mLegacy = raw.match(/[#&?]session=([^&\s]+)/);
    if (mLegacy) {
      const p = Sync.decode(mLegacy[1]);
      if (p) return { payload: p, format: "legacy" };
    }
    if (/^[-_A-Za-z0-9]+$/.test(raw) && raw.length > 12) {
      const p = await Sync.decodeShort(raw);
      if (p) return { payload: p, format: "short" };
      const p2 = Sync.decode(raw);
      if (p2) return { payload: p2, format: "legacy" };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.app === "old-reddit-json-reporter") {
        return { payload: parsed, format: "json" };
      }
    } catch (_) {}
    return null;
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
        const existing = Campaigns.list ? Campaigns.list() : [];
        for (const c of existing) {
          if (Campaigns.remove) Campaigns.remove(c.id);
        }
        campaignsReplaced = existing.length;
        /* Short-format payloads don't carry `id` / `createdAt`
         * (regenerated on import). Legacy payloads do. Either way
         * Campaigns.add() will produce a fresh id; Campaigns.importJson
         * preserves the original id when present. We prefer the latter
         * for legacy payloads to keep deep-link references stable. */
        const hasIds = payload.campaigns.length && payload.campaigns.every((c) => !!c.id);
        if (Campaigns.importJson && hasIds) {
          Campaigns.importJson(JSON.stringify(payload.campaigns));
          campaignsAdded = payload.campaigns.length;
        } else if (Campaigns.add) {
          for (const c of payload.campaigns) {
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
        const existing = Campaigns.list ? Campaigns.list() : [];
        const seenIds = new Set(existing.map((c) => c.id));
        const seenSig = new Set(existing.map((c) =>
          c.name + "|" + (c.postIds || []).slice().sort().join(",")));
        campaignsKept = existing.length;
        for (const c of payload.campaigns) {
          const sig = c.name + "|" + (c.postIds || []).slice().sort().join(",");
          if ((c.id && seenIds.has(c.id)) || seenSig.has(sig)) continue;
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

  /* Approximate length-on-the-clipboard so we can warn the user when
   * a session is too big to be a comfortable URL. Async because the
   * short encoder needs gzip. */
  Sync.estimateSize = async function () {
    try { return (await Sync.encodeShort(Sync.collectPayload())).length; } catch (_) { return 0; }
  };

  if (typeof window !== "undefined") window.Sync = Sync;
  if (typeof module !== "undefined" && module.exports) module.exports = Sync;
})();
