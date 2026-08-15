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
 * FETCHING BYTES IS THE HARD PART
 *
 *   <img src="https://i.redd.it/…"> displays fine from a phone/home IP.
 *   JavaScript fetch() of the same URL does not: i.redd.it sends no CORS
 *   headers, and every public CORS proxy is a datacenter IP that Reddit
 *   answers with 403. So the network path is best-effort only.
 *
 *   When every proxy fails, we fall back to a local file / clipboard
 *   paste — the image is already on screen, so saving or pasting it is
 *   enough for OCR to run entirely on-device with no Reddit round-trip.
 * ===================================================================== */
(function () {
  "use strict";

  const ImageText = {};
  const TESSERACT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

  /* Ordered fetch attempts. Image CDNs that re-host with CORS headers
   * come first; generic CORS relays last (often 403 on i.redd.it). */
  function proxyTargets(url) {
    const bare = String(url || "").replace(/^https?:\/\//i, "");
    const full = encodeURIComponent(url);
    const bareEnc = encodeURIComponent(bare);
    return [
      /* Direct — works for hosts that send ACAO (rare for Reddit). */
      { label: "direct", href: url },
      /* wsrv.nl / images.weserv.nl — image CDN that adds CORS. */
      { label: "wsrv", href: "https://wsrv.nl/?url=" + bareEnc + "&output=jpg&n=-1" },
      { label: "weserv", href: "https://images.weserv.nl/?url=" + bareEnc + "&output=jpg&n=-1" },
      { label: "wsrv-full", href: "https://wsrv.nl/?url=" + full + "&output=jpg&n=-1" },
      /* Generic relays — may 403 on Reddit CDN. */
      { label: "allorigins", href: "https://api.allorigins.win/raw?url=" + full },
      { label: "corsproxy", href: "https://corsproxy.io/?" + full },
      { label: "codetabs", href: "https://api.codetabs.com/v1/proxy?quest=" + full },
    ];
  }

  let tessLoading = null;
  let workerPromise = null;
  const inflight = new Map();

  function cache() {
    return (window.AppState && AppState.imageTextByPost) || null;
  }

  ImageText.fromListing = function (d) {
    const bits = [];
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

  ImageText.urlFor = function (post) {
    if (!post) return "";
    const url = String(post.url || "").replace(/&amp;/g, "&");
    if (/i\.redd\.it\//i.test(url) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) return url;
    if (post.preview_url && /^https?:/i.test(post.preview_url)) {
      return String(post.preview_url).replace(/&amp;/g, "&");
    }
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
    if (source !== "caption" && ImageText.isPlausible && !ImageText.isPlausible(clean)) {
      return;
    }
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

  function looksLikeImageBlob(blob) {
    if (!blob || !blob.size) return false;
    if (blob.type && /^image\//i.test(blob.type)) return true;
    if (blob.type && /octet-stream/i.test(blob.type)) return true;
    /* Relays sometimes omit Content-Type; size alone is a weak signal. */
    return !blob.type && blob.size > 512;
  }

  async function fetchViaHttp(href) {
    const res = await fetch(href, { credentials: "omit", mode: "cors" });
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    const blob = await res.blob();
    if (!looksLikeImageBlob(blob)) throw new Error("not an image");
    return blob;
  }

  /* Load through <img crossOrigin> + canvas — works when the URL sends
   * ACAO (weserv does). Avoids some fetch() Content-Type quirks. */
  function fetchViaImageElement(href) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("image load timeout"));
      }, 20000);
      function cleanup() {
        window.clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
      }
      img.onload = () => {
        try {
          const w = img.naturalWidth || 0;
          const h = img.naturalHeight || 0;
          if (w < 8 || h < 8) throw new Error("empty image");
          const canvas = document.createElement("canvas");
          /* Cap huge screenshots so OCR stays responsive on phones. */
          const maxEdge = 1600;
          const scale = Math.min(1, maxEdge / Math.max(w, h));
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            cleanup();
            if (!blob) reject(new Error("canvas export failed"));
            else resolve(blob);
          }, "image/jpeg", 0.92);
        } catch (err) {
          cleanup();
          reject(err);
        }
      };
      img.onerror = () => {
        cleanup();
        reject(new Error("image element failed"));
      };
      img.src = href;
    });
  }

  async function fetchImageBlob(url, onStatus) {
    const attempts = proxyTargets(url);
    let saw403 = false;
    let lastErr = null;
    for (const attempt of attempts) {
      if (typeof onStatus === "function") onStatus("Fetching image…");
      try {
        /* Prefer img+canvas for weserv (CORS-friendly); fetch for others. */
        const blob = /wsrv|weserv/i.test(attempt.label)
          ? await fetchViaImageElement(attempt.href).catch(() => fetchViaHttp(attempt.href))
          : await fetchViaHttp(attempt.href);
        return blob;
      } catch (err) {
        lastErr = err;
        if (err && (err.status === 403 || /HTTP 403/.test(String(err.message || "")))) {
          saw403 = true;
        }
      }
    }
    const err = lastErr || new Error("Could not fetch image");
    err.blocked = saw403;
    err.message = saw403
      ? "Reddit blocked image download (403). Use a saved copy or paste a screenshot."
      : (err.message || "Could not fetch image");
    throw err;
  }

  /* Hidden file picker — used when Reddit blocks every network path. */
  ImageText.pickLocalFile = function (opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.style.position = "fixed";
      input.style.left = "-9999px";
      document.body.appendChild(input);
      let settled = false;
      function done(err, file) {
        if (settled) return;
        settled = true;
        try { input.remove(); } catch (_) {}
        window.removeEventListener("focus", onFocusCheck);
        if (err) reject(err);
        else resolve(file);
      }
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        if (!file) done(new Error("No image selected"));
        else done(null, file);
      });
      /* User cancelled the dialog — focus returns with no file. */
      function onFocusCheck() {
        window.setTimeout(() => {
          if (!settled && (!input.files || !input.files.length)) {
            done(new Error("Cancelled"));
          }
        }, 600);
      }
      window.addEventListener("focus", onFocusCheck);
      try {
        input.click();
      } catch (err) {
        done(err || new Error("Could not open file picker"));
      }
    });
  };

  ImageText.readClipboardImage = async function () {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      throw new Error("Clipboard image paste is not available here");
    }
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = (item.types || []).find((t) => /^image\//i.test(t));
      if (!type) continue;
      const blob = await item.getType(type);
      if (blob) return blob;
    }
    throw new Error("No image on the clipboard");
  };

  function tidyOcr(raw) {
    return String(raw || "")
      .replace(/\u2018|\u2019/g, "'")
      .replace(/\u201c|\u201d/g, '"')
      .replace(/[|]/g, "I")
      .replace(/[^\S\n]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 2500);
  }

  /* Yellow caption cards and meme text fail hard when OCR treats the
   * photo as the signal. Emphasize light / warm pixels, upscale, and
   * stretch contrast before Tesseract sees the frame. */
  async function preprocessBlob(blob) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (_) {
      return blob;
    }
    const srcW = bitmap.width || 0;
    const srcH = bitmap.height || 0;
    if (srcW < 8 || srcH < 8) {
      try { bitmap.close(); } catch (_) {}
      return blob;
    }
    /* Prefer a long edge around 1600–2000px — captions on phone screenshots
     * need scale-up; giant originals just burn OCR time. */
    const target = 1800;
    const scale = Math.max(1.25, Math.min(2.75, target / Math.max(srcW, srcH)));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    try { bitmap.close(); } catch (_) {}

    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const gray = new Float32Array(w * h);
    let min = 255;
    let max = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      /* Luma plus a yellow/white boost — Social Security–style captions
       * are often bright yellow on photos and vanish in plain grayscale. */
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const warm = (r + g) * 0.5 - b * 0.35;
      let v = Math.max(luma, warm);
      /* Crush mid-mud so letters separate from busy backgrounds. */
      v = (v - 90) * 1.55 + 90;
      v = Math.max(0, Math.min(255, v));
      gray[p] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = Math.max(18, max - min);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      let v = ((gray[p] - min) / span) * 255;
      /* Soft threshold: keep grayscale detail, push near-white toward 255. */
      if (v > 165) v = 255 - (255 - v) * 0.25;
      else if (v < 70) v = v * 0.55;
      const out = Math.max(0, Math.min(255, Math.round(v)));
      d[i] = d[i + 1] = d[i + 2] = out;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    return await new Promise((resolve) => {
      canvas.toBlob((out) => resolve(out || blob), "image/png");
    });
  }

  function meanConfidence(data) {
    const words = (data && data.words) || [];
    const scored = words
      .map((w) => Number(w.confidence))
      .filter((c) => Number.isFinite(c) && c > 0);
    if (!scored.length) return data && Number.isFinite(data.confidence) ? data.confidence : 0;
    return scored.reduce((a, b) => a + b, 0) / scored.length;
  }

  /* Reject "lemma on A / COCK Bia" style junk so it cannot poison
   * destination matching. */
  ImageText.isPlausible = function (text, confidence) {
    const t = String(text || "").trim();
    if (t.length < 12) return false;
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    const digits = (t.match(/\d/g) || []).length;
    const spacey = (t.match(/\s/g) || []).length;
    const weird = (t.match(/[^A-Za-z0-9\s.,!?'"$:;%&\-()/]/g) || []).length;
    const alphaRatio = letters / Math.max(1, t.length);
    const weirdRatio = weird / Math.max(1, t.length);
    const words = t.split(/\s+/).filter(Boolean);
    const realish = words.filter((w) => /[A-Za-z]{3,}/.test(w)).length;
    if (alphaRatio < 0.45) return false;
    if (weirdRatio > 0.18) return false;
    if (realish < 3 && (letters + digits) < 24) return false;
    if (confidence != null && confidence < 42 && realish < 6) return false;
    if (words.length >= 4 && realish / words.length < 0.35) return false;
    /* Very short lines of noise with almost no spaces. */
    if (spacey < 2 && t.length < 40 && confidence < 55) return false;
    return true;
  };

  ImageText.clear = function (post) {
    if (!post) return;
    delete post.image_text;
    delete post.image_text_source;
    const map = cache();
    if (map && post.id) map.delete(post.id);
  };

  async function recognizeOnce(worker, blob, psm) {
    if (psm != null) {
      try {
        await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
      } catch (_) {}
    }
    const result = await worker.recognize(blob);
    const data = result && result.data;
    const text = tidyOcr(data && data.text);
    const confidence = meanConfidence(data);
    return { text, confidence, data };
  }

  ImageText.recognizeBlob = async function (blob, onStatus) {
    if (!blob) throw new Error("No image");
    if (typeof onStatus === "function") onStatus("Preparing image…");
    const prepared = await preprocessBlob(blob);
    if (typeof onStatus === "function") onStatus("Reading text in image…");
    const worker = await getWorker();
    /* 3 = fully auto; 11 = sparse text (captions / overlays); 6 = block. */
    const modes = [3, 11, 6];
    let best = null;
    for (const psm of modes) {
      try {
        const hit = await recognizeOnce(worker, prepared, psm);
        if (!hit.text) continue;
        if (!best
            || (ImageText.isPlausible(hit.text, hit.confidence)
                && hit.confidence > (best.confidence || 0) + 2)
            || (!ImageText.isPlausible(best.text, best.confidence)
                && ImageText.isPlausible(hit.text, hit.confidence))) {
          best = hit;
        }
        /* Good enough — stop early. */
        if (ImageText.isPlausible(hit.text, hit.confidence) && hit.confidence >= 62) {
          best = hit;
          break;
        }
      } catch (_) { /* try next mode */ }
    }
    if (!best || !best.text || best.text.length < 8) {
      throw new Error("No readable text found in the image");
    }
    if (!ImageText.isPlausible(best.text, best.confidence)) {
      const err = new Error(
        "OCR was too messy to trust (try Re-read, or upload a clearer crop of the caption)."
      );
      err.messy = true;
      err.raw = best.text;
      err.confidence = best.confidence;
      throw err;
    }
    return best.text;
  };

  /* Resolve text for a post: cache → captions → network OCR → local file. */
  ImageText.ensure = async function (post, opts) {
    opts = opts || {};
    if (!post || !post.id) return "";
    const hit = ImageText.getCached(post.id);
    if (hit && hit.text && !opts.force) {
      if (!ImageText.isPlausible(hit.text)) {
        ImageText.clear(post);
      } else {
        post.image_text = hit.text;
        post.image_text_source = hit.source;
        return hit.text;
      }
    }
    if (post.image_text && !opts.force) {
      if (!ImageText.isPlausible(post.image_text)) {
        ImageText.clear(post);
      } else {
        return post.image_text;
      }
    }
    if (post.media_captions && !opts.force) {
      ImageText.applyToPost(post, post.media_captions, "caption");
      return post.image_text;
    }

    if (inflight.has(post.id)) return inflight.get(post.id);

    const job = (async () => {
      let blob = opts.blob || null;
      let source = opts.blob ? "upload" : "ocr";

      if (!blob) {
        const url = ImageText.urlFor(post);
        if (url) {
          try {
            blob = await fetchImageBlob(url, opts.onStatus);
            source = "ocr";
          } catch (err) {
            /* Interactive callers get a file picker; background auto-OCR
             * stays quiet so Plan is not interrupted by a dialog. */
            if (opts.allowLocalFallback === false) throw err;
            if (!opts.interactive) throw err;
            if (typeof opts.onStatus === "function") {
              opts.onStatus("Reddit blocked download — pick the image…");
            }
            try {
              if (opts.preferClipboard) {
                blob = await ImageText.readClipboardImage();
                source = "paste";
              }
            } catch (_) { /* fall through to file picker */ }
            if (!blob) {
              blob = await ImageText.pickLocalFile();
              source = "upload";
            }
          }
        } else if (opts.interactive) {
          blob = await ImageText.pickLocalFile();
          source = "upload";
        } else {
          throw new Error("No image URL to read");
        }
      }

      const text = await ImageText.recognizeBlob(blob, opts.onStatus);
      ImageText.applyToPost(post, text, source);
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
