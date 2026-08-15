/* =====================================================================
 * IMAGE TEXT — captions + on-device OCR (no cloud AI)
 * ---------------------------------------------------------------------
 * Link and screenshot posts often carry their real subject inside the
 * image. Reddit does not ship OCR in the API. What we can do without a
 * generative model:
 *
 *   1. Gallery / media captions when the archive returned them.
 *   2. oEmbed / media titles already on the post.
 *   3. Tesseract.js in the browser — classical OCR (LSTM), loaded on
 *      demand from a CDN, run against the image bytes. No OpenAI /
 *      Vision API. First run downloads the eng traineddata (~few MB).
 *
 * i.redd.it and similar hosts rarely send CORS for canvas reads, so
 * bytes are fetched through the same public CORS proxy chain Syndicate
 * already uses for feeds.
 * ===================================================================== */
(function () {
  "use strict";

  const ImageText = {};
  const PROXY = "https://corsproxy.io/?";
  const TESSERACT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

  let tessLoading = null;
  let workerPromise = null;
  const inflight = new Map();

  function cache() {
    return (window.AppState && AppState.imageTextByPost) || null;
  }

  /* Pull free text Reddit already attached — captions and media titles.
   * Called from normalizePost so thin image posts get something before
   * OCR ever runs. */
  ImageText.fromListing = function (d) {
    const bits = [];
    const meta = d && d.media_metadata;
    if (meta && typeof meta === "object") {
      for (const key of Object.keys(meta)) {
        const m = meta[key];
        if (!m || typeof m !== "object") continue;
        if (m.s && m.s.u) {/* ignore urls */}
      }
    }
    const gallery = d && d.gallery_data && Array.isArray(d.gallery_data.items)
      ? d.gallery_data.items
      : [];
    for (const item of gallery) {
      const cap = item && item.caption;
      if (cap && String(cap).trim()) bits.push(String(cap).trim());
    }
    const oe = (d && d.media && d.media.oembed) || {};
    if (oe.description && String(oe.description).trim()) {
      bits.push(String(oe.description).trim().slice(0, 800));
    }
    if (oe.title && d.title && String(oe.title).trim() !== String(d.title).trim()) {
      bits.push(String(oe.title).trim());
    }
    return bits.join("\n").trim();
  };

  /* Best URL to OCR — prefer the direct image, fall back to a large preview. */
  ImageText.urlFor = function (post) {
    if (!post) return "";
    const url = String(post.url || "");
    if (/i\.redd\.it\//i.test(url) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) return url;
    if (post.preview_url && /^https?:/i.test(post.preview_url)) return post.preview_url;
    if (post.media_thumbnail && /^https?:/i.test(post.media_thumbnail)
        && !/default|self|nsfw|spoiler/i.test(post.media_thumbnail)) {
      return post.media_thumbnail;
    }
    if (post.thumbnail && /^https?:/i.test(post.thumbnail)
        && !/default|self|nsfw|spoiler/i.test(post.thumbnail)) {
      return post.thumbnail;
    }
    return "";
  };

  ImageText.isImagePost = function (post) {
    if (!post) return false;
    if (window.Rules && Rules.classify) {
      const k = Rules.classify(post);
      if (k && (k.kind === "image" || k.kind === "gallery")) return true;
    }
    return !!ImageText.urlFor(post);
  };

  ImageText.getCached = function (postId) {
    const map = cache();
    if (!map || !postId) return null;
    return map.get(postId) || null;
  };

  ImageText.applyToPost = function (post, text, source) {
    if (!post) return;
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    post.image_text = clean;
    post.image_text_source = source || "ocr";
    const map = cache();
    if (map && post.id) {
      map.set(post.id, { text: clean, source: post.image_text_source, at: Date.now() });
    }
  };

  function loadTesseract() {
    if (window.Tesseract && Tesseract.createWorker) return Promise.resolve(Tesseract);
    if (tessLoading) return tessLoading;
    tessLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TESSERACT_SRC;
      s.async = true;
      s.onload = () => {
        if (window.Tesseract && Tesseract.createWorker) resolve(Tesseract);
        else reject(new Error("Tesseract failed to load"));
      };
      s.onerror = () => reject(new Error("Could not load OCR engine (CDN)"));
      document.head.appendChild(s);
    });
    return tessLoading;
  }

  function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = loadTesseract().then((Tess) => Tess.createWorker("eng"));
    return workerPromise;
  }

  async function fetchImageBlob(url) {
    /* Direct first — some CDNs allow CORS; fall back to proxy. */
    const attempts = [url, PROXY + encodeURIComponent(url)];
    let lastErr = null;
    for (const target of attempts) {
      try {
        const res = await fetch(target, { credentials: "omit", mode: "cors" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        if (!blob || !blob.size) throw new Error("empty image");
        if (blob.type && !/^image\//i.test(blob.type) && !/octet-stream/i.test(blob.type)) {
          /* Proxy sometimes returns HTML error pages. */
          throw new Error("not an image");
        }
        return blob;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Could not fetch image");
  }

  function tidyOcr(raw) {
    return String(raw || "")
      .replace(/[|]/g, "I")
      .replace(/[^\S\n]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 2500);
  }

  /* Resolve text for a post: cache → listing captions → OCR. */
  ImageText.ensure = async function (post, opts) {
    opts = opts || {};
    if (!post || !post.id) return "";
    const hit = ImageText.getCached(post.id);
    if (hit && hit.text && !opts.force) {
      post.image_text = hit.text;
      post.image_text_source = hit.source;
      return hit.text;
    }
    if (post.image_text && !opts.force) return post.image_text;
    if (post.media_captions && !opts.force) {
      ImageText.applyToPost(post, post.media_captions, "caption");
      return post.image_text;
    }

    if (inflight.has(post.id)) return inflight.get(post.id);

    const job = (async () => {
      const url = ImageText.urlFor(post);
      if (!url) throw new Error("No image URL to read");
      if (typeof opts.onStatus === "function") opts.onStatus("Fetching image…");
      const blob = await fetchImageBlob(url);
      if (typeof opts.onStatus === "function") opts.onStatus("Reading text in image…");
      const worker = await getWorker();
      const result = await worker.recognize(blob);
      const text = tidyOcr(result && result.data && result.data.text);
      if (!text || text.length < 8) {
        throw new Error("No readable text found in the image");
      }
      ImageText.applyToPost(post, text, "ocr");
      return text;
    })();

    inflight.set(post.id, job);
    try {
      return await job;
    } finally {
      inflight.delete(post.id);
    }
  };

  window.ImageText = ImageText;
})();
