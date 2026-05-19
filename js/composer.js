/* Markdown composer + crossposter.
 *
 * Lets a user compose a campaign post in-dashboard (markdown source +
 * live preview + toolbar + char counters), then bulk-emit pre-filled
 * Reddit /submit?... URLs for every selected target subreddit so the
 * SAME body lands on every sub — a real crosspost, not just a share
 * link.
 *
 * Two body modes:
 *   - "single"     one canonical title + body for every target
 *   - "per-target" each checked target gets its own editable copy,
 *                  defaulted from the canonical
 *
 * Drafts persist per campaign in localStorage so a user can refine
 * a campaign post over multiple sessions.
 *
 * The composer is opened from a "Compose post" button in the
 * campaign-detail panel. It does NOT submit on the user's behalf —
 * Reddit auth would be required for that, which a static site
 * cannot safely hold. The composer just opens Reddit's submit page
 * with the title + body prefilled; the user reviews and clicks Post.
 *
 * Mark-posted flow: after a target is posted to, the user pastes the
 * resulting Reddit URL back into the composer. Util.parsePostRefs
 * extracts the post ID, Campaigns.addPostIds folds it into the
 * campaign for tracking, and the target row visually flips to a
 * "posted" state.
 */
(function () {
  const Composer = {};

  /* localStorage key shape. Per-campaign so a user managing several
   * campaigns at once doesn't see drafts cross-contaminating. */
  const DRAFT_KEY_PREFIX = "rj.composerDraft.";

  /* Reddit's hard caps. The 40k body cap is Reddit's selftext limit;
   * the 8000 URL cap is what mobile browsers (notably iOS Safari)
   * tolerate before silently truncating the prefilled body. */
  const TITLE_MAX = 300;
  const BODY_MAX = 40000;
  const URL_SOFT_MAX = 7000;
  const URL_HARD_MAX = 8000;
  const TRUNCATE_TARGET_BODY = 7500;

  Composer.LIMITS = {
    titleMax: TITLE_MAX,
    bodyMax: BODY_MAX,
    urlSoftMax: URL_SOFT_MAX,
    urlHardMax: URL_HARD_MAX,
    truncateTargetBody: TRUNCATE_TARGET_BODY,
  };

  /* ---------------------------------------------------------------
   * Markdown rendering
   *
   * Uses the bundled `marked` library (vendor/marked.min.js). After
   * marked produces HTML we run a small post-processor for the two
   * features Reddit cares about that vanilla GitHub-flavored
   * markdown doesn't natively express:
   *
   *   1. Spoilers   `>!hidden!<`   ->  <span class="spoiler">…</span>
   *   2. u/X r/X mentions          ->  linkified
   *
   * Plus a sanitizer pass to strip <script>, <iframe>, on* attrs,
   * and javascript: URLs from the rendered HTML. The preview is shown
   * to the SAME user who wrote the markdown so XSS isn't a strict
   * concern, but we sanitize anyway as defense-in-depth in case a
   * draft is shared via Sync (the .body lands in another user's DOM).
   * ------------------------------------------------------------- */
  /* Pre-process spoiler syntax `>!text!<` BEFORE marked runs.
   *
   * If we let marked see it raw, the leading `>` is consumed as a
   * blockquote and the spoiler markers are dropped/escaped. By
   * substituting a span at the source level, marked sees raw HTML
   * (which GFM allows by default) and emits it through to the
   * sanitizer pass, which keeps it because span is on the allowlist.
   *
   * The non-greedy group + boundary anchors stop runaway matches
   * on multi-spoiler lines. */
  const SPOILER_SOURCE_RE = /(^|[^>!])>!([^!\n][^\n]*?)!</g;
  const MENTION_RE = /(?:^|[\s>(])([ru])\/([A-Za-z0-9_-]{2,30})/g;
  /* Conservative tag/attr allowlist for the preview pane. */
  const ALLOWED_TAGS = new Set([
    "p", "br", "hr", "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "a", "img", "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td", "span",
  ]);
  const ALLOWED_ATTRS = {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    span: ["class"],
  };

  function sanitize(html) {
    if (typeof DOMParser === "undefined") return html;
    const doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
    const root = doc.body.firstChild;
    if (!root) return "";
    const walk = (el) => {
      const kids = Array.from(el.childNodes);
      for (const node of kids) {
        if (node.nodeType === 1 /* Element */) {
          const tag = node.tagName.toLowerCase();
          if (!ALLOWED_TAGS.has(tag)) {
            /* Replace forbidden element with its text content. */
            node.replaceWith(doc.createTextNode(node.textContent || ""));
            continue;
          }
          /* Strip non-allowlisted attributes. */
          const allowed = ALLOWED_ATTRS[tag] || [];
          for (const attr of Array.from(node.attributes)) {
            if (!allowed.includes(attr.name.toLowerCase())) {
              node.removeAttribute(attr.name);
              continue;
            }
            /* Block javascript: / data: text URLs (data:image is OK). */
            if ((attr.name === "href" || attr.name === "src")) {
              const v = String(attr.value || "").trim().toLowerCase();
              if (v.startsWith("javascript:") || v.startsWith("vbscript:")) {
                node.removeAttribute(attr.name);
              }
              if (attr.name === "src" && v.startsWith("data:") && !v.startsWith("data:image/")) {
                node.removeAttribute(attr.name);
              }
            }
          }
          /* Force external links to noopener + new tab. */
          if (tag === "a") {
            node.setAttribute("rel", "noopener noreferrer");
            node.setAttribute("target", "_blank");
          }
          walk(node);
        }
      }
    };
    walk(root);
    return root.innerHTML;
  }

  Composer.renderMarkdown = function (md) {
    if (typeof md !== "string" || !md.trim()) return "";
    /* Pre-process: substitute Reddit spoilers with raw HTML BEFORE
     * marked runs. Marked passes raw inline HTML through unchanged
     * when GFM is enabled, so the resulting span survives into the
     * sanitizer pass, which retains it (span is on the allowlist). */
    const preprocessed = md.replace(SPOILER_SOURCE_RE, (full, lead, inner) =>
      lead + '<span class="spoiler">' + inner + "</span>"
    );
    let html;
    try {
      const m = (typeof window !== "undefined" && window.marked) || (typeof globalThis !== "undefined" && globalThis.marked);
      if (m && (m.parse || typeof m === "function")) {
        html = (m.parse ? m.parse(preprocessed, { gfm: true, breaks: true }) : m(preprocessed, { gfm: true, breaks: true }));
      } else {
        /* No marked loaded — fall back to plain text with paragraph
         * breaks so the preview still tells the user something. */
        html = "<pre>" + md.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])) + "</pre>";
      }
    } catch (err) {
      console.warn("[composer] markdown render failed:", err);
      return "<em>Preview unavailable — check console.</em>";
    }
    /* Linkify u/foo and r/bar mentions. */
    html = html.replace(MENTION_RE, (m, kind, name) => {
      const lead = m.slice(0, m.length - kind.length - 1 - name.length);
      const href = "https://www.reddit.com/" + kind + "/" + name;
      return lead + `<a href="${href}">${kind}/${name}</a>`;
    });
    return sanitize(html);
  };

  /* Render markdown to "mobile-app-friendly" HTML.
   *
   * Background: Reddit's mobile app body editor is a Tiptap-style
   * rich-text composer with a CONSERVATIVE paste schema. It accepts
   *   <p>  <br>  <strong>  <em>  <s>  <code>  <a>
   * but unwraps everything else to plain text — that means the
   * structural tags `<h1>`-`<h6>`, `<ul>`/`<ol>`/`<li>`,
   * `<blockquote>`, `<pre>`, `<table>` all collapse to their inner
   * text content, losing visual structure.
   *
   * The user's screenshot showed exactly this: pasted body had
   * bolded headings (h2 -> bold paragraph) but the bullet list of
   * partner organizations rendered as plain text lines, no bullets.
   *
   * Fix: this renderer post-processes Composer.renderMarkdown's
   * output to flatten structural tags into <p>/<br> with Unicode
   * prefixes that survive the app's plain-text fallback path:
   *
   *   <h1>-<h6>      ->  <p><strong>...</strong></p>
   *   <ul><li>x</li> ->  <p>•&nbsp;x<br>•&nbsp;y</p>
   *   <ol><li>x</li> ->  <p>1.&nbsp;x<br>2.&nbsp;y</p>
   *   <blockquote>   ->  <p>▎&nbsp;quoted text</p>
   *   <pre><code>    ->  <p>code content</p>
   *   <table>        ->  <p>row 1 cells | row 2 cells</p>
   *
   * Inline formatting (<strong>, <em>, <a>, <code>) inside the
   * flattened blocks is preserved because the app's schema
   * accepts those.
   *
   * The result reads correctly in EVERY paste destination tested:
   *   - Reddit mobile app: bullets visible (via Unicode), bold
   *     paragraphs render
   *   - Reddit web (new/old): paragraphs with literal bullet chars,
   *     readable but not "list-like"
   *   - Apple Notes / Slack / Pages / Linear: same — paragraphs
   *     with visible bullets
   *
   * The "list semantics get lost on web Reddit" trade is worth it
   * because the user's primary workflow is mobile app paste. */
  const FLATTEN_BLOCK_TAGS = "p, ul, ol, blockquote, pre, table, hr";
  Composer.renderForMobilePaste = function (md) {
    if (typeof md !== "string" || !md.trim()) return "";
    const baseHtml = Composer.renderMarkdown(md);
    if (!baseHtml) return "";

    /* SSR / no-DOMParser fallback — return the standard HTML
     * and let the caller rely on text/plain to carry the body. */
    if (typeof DOMParser === "undefined") return baseHtml;

    const doc = new DOMParser().parseFromString("<div>" + baseHtml + "</div>", "text/html");
    const root = doc.body.firstChild;
    if (!root) return baseHtml;

    /* Helper: clone an <li> and strip nested block elements so the
     * resulting fragment carries only inline children. Used so a
     * list item like "<li><p>foo</p><ul>nested</ul></li>" produces
     * "foo" + the nested list flattened separately. */
    function inlineCloneOf(node) {
      const clone = node.cloneNode(true);
      clone.querySelectorAll(FLATTEN_BLOCK_TAGS).forEach((el) => {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
      });
      return clone;
    }

    /* 1. Headings -> <p><strong>…</strong></p>. Reddit's app already
     *    collapses heading sizes to bold-paragraph anyway, so this
     *    just makes the conversion explicit and predictable. */
    root.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
      const p = doc.createElement("p");
      const strong = doc.createElement("strong");
      while (h.firstChild) strong.appendChild(h.firstChild);
      p.appendChild(strong);
      h.parentNode.replaceChild(p, h);
    });

    /* 2. Lists. Process from deepest-nested outward so a top-level
     *    <ul> containing a sub-<ul> gets the children flattened
     *    first, then the parent. Detected by absence of nested
     *    list inside each candidate. Bounded loop so a malformed
     *    DOM can't lock the page up. */
    for (let pass = 0; pass < 12; pass++) {
      const lists = Array.from(root.querySelectorAll("ul, ol"))
        .filter((l) => !l.querySelector("ul, ol"));
      if (!lists.length) break;
      lists.forEach((list) => {
        const ordered = list.tagName.toLowerCase() === "ol";
        const items = Array.from(list.children).filter((c) => c.tagName.toLowerCase() === "li");
        const p = doc.createElement("p");
        items.forEach((li, i) => {
          const prefix = ordered ? `${i + 1}.\u00A0` : "\u2022\u00A0";
          p.appendChild(doc.createTextNode(prefix));
          const inline = inlineCloneOf(li);
          while (inline.firstChild) p.appendChild(inline.firstChild);
          if (i < items.length - 1) p.appendChild(doc.createElement("br"));
        });
        list.parentNode.replaceChild(p, list);
      });
    }

    /* 3. Blockquotes -> <p> prefixed with ▎ (left vertical bar
     *    U+258E). Multi-paragraph quotes get one ▎ prefix per
     *    paragraph, joined with <br>. */
    root.querySelectorAll("blockquote").forEach((bq) => {
      const paras = Array.from(bq.querySelectorAll("p"));
      const p = doc.createElement("p");
      if (paras.length) {
        paras.forEach((inner, i) => {
          p.appendChild(doc.createTextNode("\u258E\u00A0"));
          const inline = inlineCloneOf(inner);
          while (inline.firstChild) p.appendChild(inline.firstChild);
          if (i < paras.length - 1) p.appendChild(doc.createElement("br"));
        });
      } else {
        /* No nested <p> — quote was inline. Keep it simple. */
        p.appendChild(doc.createTextNode("\u258E\u00A0"));
        const inline = inlineCloneOf(bq);
        while (inline.firstChild) p.appendChild(inline.firstChild);
      }
      bq.parentNode.replaceChild(p, bq);
    });

    /* 4. Code blocks -> <p>. Loses monospace + indentation but
     *    Reddit's app strips those anyway; preserving the text is
     *    the achievable goal. */
    root.querySelectorAll("pre").forEach((pre) => {
      const p = doc.createElement("p");
      const code = pre.querySelector("code");
      const text = (code ? code.textContent : pre.textContent) || "";
      /* Preserve newlines as <br> so multi-line code reads right. */
      const lines = text.replace(/\n+$/, "").split("\n");
      lines.forEach((line, i) => {
        p.appendChild(doc.createTextNode(line));
        if (i < lines.length - 1) p.appendChild(doc.createElement("br"));
      });
      pre.parentNode.replaceChild(p, pre);
    });

    /* 5. Tables -> "row1 cell | row1 cell\nrow2 cell | row2 cell"
     *    paragraphs. Crude but readable. */
    root.querySelectorAll("table").forEach((table) => {
      const lines = [];
      table.querySelectorAll("tr").forEach((tr) => {
        const cells = [];
        tr.querySelectorAll("th, td").forEach((c) => cells.push((c.textContent || "").trim()));
        lines.push(cells.join(" \u2502 "));
      });
      const p = doc.createElement("p");
      lines.forEach((line, i) => {
        p.appendChild(doc.createTextNode(line));
        if (i < lines.length - 1) p.appendChild(doc.createElement("br"));
      });
      table.parentNode.replaceChild(p, table);
    });

    /* 6. <hr> -> <p>──────</p> (decorative line) */
    root.querySelectorAll("hr").forEach((hr) => {
      const p = doc.createElement("p");
      p.textContent = "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500";
      hr.parentNode.replaceChild(p, hr);
    });

    return root.innerHTML;
  };

  /* Plain-text equivalent of the mobile-paste HTML — extracts
   * textContent from the flattened HTML so the Unicode prefixes
   * are preserved. Used as the text/plain blob in the clipboard
   * write so apps that pick text/plain instead of text/html still
   * see visible bullets / quote markers / numbered items. */
  Composer.renderForMobilePastePlain = function (md) {
    const html = Composer.renderForMobilePaste(md);
    if (!html) return "";
    if (typeof DOMParser === "undefined") return md;
    /* Convert <br> back to \n, <p> boundaries to \n\n. Inline tags
     * (<strong>, <em>, <a>) are dropped — plain text can't render
     * them. The Unicode prefixes (•, 1., ▎) are already in the
     * text nodes so they survive textContent extraction. */
    const doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
    const root = doc.body.firstChild;
    /* Replace <br> with newline placeholder. */
    root.querySelectorAll("br").forEach((br) => br.parentNode.replaceChild(doc.createTextNode("\n"), br));
    /* Insert paragraph separators between <p> blocks. */
    const paragraphs = Array.from(root.children).map((c) => c.textContent.trim()).filter(Boolean);
    return paragraphs.join("\n\n");
  };

  /* ---------------------------------------------------------------
   * Toolbar actions
   *
   * Each action takes the current textarea, splits it at the
   * selection, and either WRAPS the selection (bold/italic) or
   * INSERTS a snippet at the line/cursor (lists, headers). The
   * cursor is repositioned afterward so the user can keep typing
   * without re-clicking into the textarea.
   * ------------------------------------------------------------- */
  Composer.applyToolbar = function (action, textarea) {
    if (!textarea) return;
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const value = textarea.value || "";
    const before = value.slice(0, start);
    const sel = value.slice(start, end);
    const after = value.slice(end);

    function wrap(left, right, placeholder) {
      const inner = sel || placeholder || "";
      const next = before + left + inner + right + after;
      textarea.value = next;
      const a = before.length + left.length;
      const b = a + inner.length;
      textarea.setSelectionRange(a, b);
    }

    function lineStart() {
      /* Find the index of the start of the line the cursor sits on
       * so block-level prefixes (#, >, -) can be inserted at column 0. */
      const i = before.lastIndexOf("\n");
      return i + 1; // 0 if no newline (first line)
    }

    function insertAtLineStart(prefix) {
      const ls = lineStart();
      const head = value.slice(0, ls);
      const tail = value.slice(ls);
      textarea.value = head + prefix + tail;
      const newPos = (start || 0) + prefix.length;
      textarea.setSelectionRange(newPos, newPos);
    }

    switch (action) {
      case "bold":      wrap("**", "**", "bold text"); break;
      case "italic":    wrap("*", "*", "italic text"); break;
      case "strike":    wrap("~~", "~~", "strikethrough"); break;
      case "code":      wrap("`", "`", "code"); break;
      case "spoiler":   wrap(">!", "!<", "hidden"); break;
      case "h1":        insertAtLineStart("# "); break;
      case "h2":        insertAtLineStart("## "); break;
      case "h3":        insertAtLineStart("### "); break;
      case "quote":     insertAtLineStart("> "); break;
      case "ul":        insertAtLineStart("- "); break;
      case "ol":        insertAtLineStart("1. "); break;
      case "hr": {
        const next = before + (before.endsWith("\n\n") || !before ? "" : (before.endsWith("\n") ? "\n" : "\n\n")) + "---\n\n" + after;
        textarea.value = next;
        const pos = next.length - after.length;
        textarea.setSelectionRange(pos, pos);
        break;
      }
      case "link": {
        const url = (typeof prompt === "function") ? prompt("Link URL?", "https://") : "";
        if (url == null) return;
        wrap("[", "](" + (url || "url") + ")", sel || "link text");
        break;
      }
      case "image": {
        const url = (typeof prompt === "function") ? prompt("Image URL?", "https://") : "";
        if (url == null) return;
        wrap("![", "](" + (url || "url") + ")", sel || "alt text");
        break;
      }
      case "codeblock": {
        /* Fenced code block — prepend a blank line if needed so the
         * fence isn't merged with the previous paragraph. */
        const head = before.endsWith("\n\n") || !before ? before : (before.endsWith("\n") ? before + "\n" : before + "\n\n");
        const inner = sel || "code";
        const lang = ""; // future: prompt for language
        const next = head + "```" + lang + "\n" + inner + "\n```\n" + after;
        textarea.value = next;
        const a = head.length + 4 + lang.length;
        const b = a + inner.length;
        textarea.setSelectionRange(a, b);
        break;
      }
      case "table": {
        const skel = "| Column 1 | Column 2 |\n| --- | --- |\n| value | value |\n";
        const head = before.endsWith("\n\n") || !before ? before : (before.endsWith("\n") ? before + "\n" : before + "\n\n");
        const next = head + skel + after;
        textarea.value = next;
        const pos = head.length + skel.length;
        textarea.setSelectionRange(pos, pos);
        break;
      }
      default:
        return;
    }
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  /* ---------------------------------------------------------------
   * Draft state + persistence
   *
   * Default-empty per-campaign draft. Lives in localStorage under
   * `rj.composerDraft.<campaignId>` so each campaign has its own
   * compose history. The full draft (including per-target overrides)
   * is just JSON; size-wise it's well under any localStorage cap
   * even with 100 targets.
   * ------------------------------------------------------------- */
  function defaultDraft(campaignId) {
    return {
      campaignId: campaignId || "",
      title: "",
      body: "",
      isLinkPost: false,
      linkUrl: "",
      imageUrl: "",
      mode: "single", // or "per-target"
      targets: [],    // [{ sub, checked, seed, title?, body?, posted, postedUrl, postedAt }]
      updatedAt: 0,
    };
  }
  Composer.defaultDraft = defaultDraft;

  Composer.loadDraft = function (campaignId) {
    if (!campaignId) return defaultDraft("");
    try {
      const raw = localStorage.getItem(DRAFT_KEY_PREFIX + campaignId);
      if (!raw) return defaultDraft(campaignId);
      const parsed = JSON.parse(raw);
      /* Merge with defaults so old drafts gain new fields without
       * crashing the UI. */
      return Object.assign(defaultDraft(campaignId), parsed, { campaignId });
    } catch (_) {
      return defaultDraft(campaignId);
    }
  };

  Composer.saveDraft = function (draft) {
    if (!draft || !draft.campaignId) return false;
    try {
      const out = Object.assign({}, draft, { updatedAt: Date.now() });
      localStorage.setItem(DRAFT_KEY_PREFIX + draft.campaignId, JSON.stringify(out));
      return true;
    } catch (e) {
      console.warn("[composer] saveDraft failed:", e && e.message);
      return false;
    }
  };

  Composer.clearDraft = function (campaignId) {
    if (!campaignId) return;
    try { localStorage.removeItem(DRAFT_KEY_PREFIX + campaignId); } catch (_) {}
  };

  /* ---------------------------------------------------------------
   * Submit URL emission
   *
   * For each checked target, build a Reddit /submit URL using either
   * the canonical body (mode "single") or the per-target body
   * (mode "per-target"). Returns array of { sub, url, length, warn }.
   * `warn` is "soft" once URL > 7000 chars (mobile browsers may
   * truncate), "hard" once > 8000, null otherwise.
   * ------------------------------------------------------------- */
  Composer.emitSubmitUrls = function (draft) {
    if (!draft || !Array.isArray(draft.targets)) return [];
    const out = [];
    for (const t of draft.targets) {
      if (!t.checked || !t.sub) continue;
      const title = (draft.mode === "per-target" && t.title) ? t.title : draft.title;
      const body  = (draft.mode === "per-target" && t.body  != null) ? t.body  : draft.body;
      const data = {
        title: title || "",
        body: body || "",
        url: draft.linkUrl || "",
        isLinkPost: !!draft.isLinkPost,
      };
      const url = (typeof Util !== "undefined" && Util.buildSubmitUrl)
        ? Util.buildSubmitUrl(t.sub, data, { maxBody: BODY_MAX })
        : null;
      if (!url) continue;
      const length = url.length;
      let warn = null;
      if (length > URL_HARD_MAX) warn = "hard";
      else if (length > URL_SOFT_MAX) warn = "soft";
      out.push({ sub: t.sub, url, length, warn, posted: !!t.posted, postedUrl: t.postedUrl || "" });
    }
    return out;
  };

  /* ---------------------------------------------------------------
   * Truncate-to-fit helper.
   *
   * When a target's submit URL exceeds the URL_HARD_MAX cap (~8KB),
   * iOS Safari silently truncates the body. Rather than letting the
   * user discover that mid-paste, this trims the per-target body to
   * a safe 7500-char limit on demand. Only applied to the per-target
   * override (in mode "per-target") because the canonical body might
   * still fit other targets that have shorter sub names.
   * ------------------------------------------------------------- */
  Composer.truncateTargetToFit = function (draft, sub) {
    if (!draft || !sub) return draft;
    const idx = (draft.targets || []).findIndex((t) => t.sub === sub);
    if (idx < 0) return draft;
    const t = draft.targets[idx];
    /* Materialize the per-target body if it's still inheriting from
     * canonical, then truncate THAT — leaves canonical untouched for
     * other targets with more URL headroom. */
    const currentBody = (draft.mode === "per-target" && t.body != null) ? t.body : draft.body;
    const trimmed = String(currentBody || "").slice(0, TRUNCATE_TARGET_BODY);
    draft.targets[idx] = Object.assign({}, t, { body: trimmed });
    if (draft.mode === "single") draft.mode = "per-target";
    return draft;
  };

  /* ---------------------------------------------------------------
   * AI prompt template
   *
   * Drops the campaign + target context into a templated prompt the
   * user can paste into ChatGPT / Claude / Gemini etc. The prompt is
   * structured to maximize the chance of getting Reddit-flavored
   * markdown back, with a hook in the first 2 sentences and a
   * neutral CTA in the last paragraph. We don't run inference
   * ourselves — static site can't safely embed an LLM key.
   * ------------------------------------------------------------- */
  Composer.buildAiPrompt = function (campaignName, draft, targetSubs, opts) {
    opts = opts || {};
    const subs = Array.isArray(targetSubs) ? targetSubs : (draft && draft.targets || []).filter((t) => t.checked).map((t) => t.sub);
    const subList = subs.length ? subs.map((s) => "  - r/" + s).join("\n") : "  (no targets selected yet)";
    const wordCount = opts.wordCount || "300-800";
    const variants = opts.variants || 1;
    const tone = opts.tone || "informative, organizing-friendly, neutral first-person plural";
    return [
      "You are helping me write a campaign post that will be cross-posted to multiple Reddit communities.",
      "",
      "Campaign: " + (campaignName || "(unnamed)"),
      "Target subreddits:",
      subList,
      "",
      "Constraints:",
      "  - Reddit-flavored markdown (use **bold**, _italic_, # headers, > quotes, lists, and [links](url)).",
      "  - Tone: " + tone + ".",
      "  - " + wordCount + " words.",
      "  - First 2 sentences MUST be a hook that earns the click. No \"I want to talk about…\" preamble.",
      "  - Final paragraph: a neutral, action-oriented call to action. No \"upvote this\", no \"please share\".",
      "  - Do NOT include subreddit-specific flair tags or moderator-tag prefixes — I'll add those manually per sub.",
      "",
      "Output format:",
      "  Title: <one line, ≤ 300 chars>",
      "  Body:",
      "  <markdown body, no front-matter>",
      (variants > 1 ? "\nProvide " + variants + " distinct variants separated by `---`." : ""),
      (draft && draft.body ? "\nExisting draft to revise/improve (optional):\n" + draft.body.slice(0, 2000) : ""),
    ].join("\n");
  };

  /* Parse an AI response that follows our template ("Title: …\nBody:\n…").
   * Returns { title, body } or { title: "", body: rawText } if the
   * format wasn't recognized so the user still gets the text into
   * the body editor.
   *
   * Tolerant to extra whitespace, leading hashes, and the AI
   * occasionally putting Title and Body on the same line. */
  Composer.parseAiResponse = function (text) {
    if (!text) return { title: "", body: "" };
    const t = String(text);
    const m = t.match(/^\s*Title:\s*(.+?)\s*\n+\s*Body:\s*\n+([\s\S]+?)\s*$/i);
    if (m) return { title: m[1].trim().slice(0, TITLE_MAX), body: m[2].trim() };
    /* No labels — treat the first non-empty line as title if it
     * looks short enough, otherwise dump everything into body. */
    const lines = t.split(/\n/);
    const firstNonEmpty = lines.find((l) => l.trim());
    if (firstNonEmpty && firstNonEmpty.length <= TITLE_MAX && lines.indexOf(firstNonEmpty) < 3) {
      const idx = lines.indexOf(firstNonEmpty);
      return {
        title: firstNonEmpty.replace(/^#+\s*/, "").trim().slice(0, TITLE_MAX),
        body: lines.slice(idx + 1).join("\n").trim(),
      };
    }
    return { title: "", body: t.trim() };
  };

  /* Export to window + module.exports */
  if (typeof window !== "undefined") window.Composer = Composer;
  if (typeof module !== "undefined" && module.exports) module.exports = Composer;
})();
