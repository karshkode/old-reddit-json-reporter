/* =====================================================================
 * DOM HELPERS
 * ---------------------------------------------------------------------
 * A deliberately tiny toolkit. The app builds most of its markup from
 * template strings, which is fine for read-only lists, but the repeated
 * `document.getElementById` / `addEventListener` / `closest` dance was
 * spread across thousands of lines. These helpers collapse it.
 * ===================================================================== */
(function () {
  const Dom = {};

  Dom.$ = function (sel, root) {
    return (root || document).querySelector(sel);
  };

  Dom.$$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  Dom.byId = function (id) {
    return document.getElementById(id);
  };

  /* Create an element. `attrs` understands `class`, `text`, `html`,
   * `dataset`, `style` (object) and `on` (event map); everything else is
   * set as an attribute. Children may be nodes or strings. */
  Dom.el = function (tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class" || k === "className") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "html") node.innerHTML = v;
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else if (k === "on") {
          for (const [evt, fn] of Object.entries(v)) node.addEventListener(evt, fn);
        } else if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, v);
      }
    }
    for (const child of [].concat(children || [])) {
      if (child == null || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  };

  /* Delegated listener. `handler` receives (event, matchedElement). */
  Dom.delegate = function (root, eventName, selector, handler, opts) {
    const host = typeof root === "string" ? Dom.byId(root) : root;
    if (!host) return function () {};
    const listener = function (e) {
      const target = e.target && e.target.closest ? e.target.closest(selector) : null;
      if (!target || !host.contains(target)) return;
      handler(e, target);
    };
    host.addEventListener(eventName, listener, opts);
    return function () { host.removeEventListener(eventName, listener, opts); };
  };

  /* Replace a container's children with freshly-built HTML. Returns the
   * container so callers can chain a query for inner nodes. */
  Dom.fill = function (target, html) {
    const node = typeof target === "string" ? Dom.byId(target) : target;
    if (!node) return null;
    node.innerHTML = html == null ? "" : html;
    return node;
  };

  Dom.show = function (target, visible) {
    const node = typeof target === "string" ? Dom.byId(target) : target;
    if (!node) return;
    node.hidden = !visible;
  };

  Dom.toggleClass = function (target, cls, on) {
    const node = typeof target === "string" ? Dom.byId(target) : target;
    if (!node) return;
    node.classList.toggle(cls, !!on);
  };

  /* Skeleton placeholder markup, used while an async section loads. */
  Dom.skeleton = function (rows, opts) {
    opts = opts || {};
    const n = rows || 3;
    let out = '<div class="skeleton-stack">';
    for (let i = 0; i < n; i++) {
      const cls = i === n - 1 ? "skeleton line-60" : i % 2 ? "skeleton line-80" : "skeleton";
      out += `<div class="${cls}"></div>`;
    }
    if (opts.chart) out += '<div class="skeleton tall"></div>';
    out += "</div>";
    return out;
  };

  /* Standard empty state. Keeps the copy structure consistent so every
   * dead end explains itself and offers the next action. */
  Dom.emptyState = function (opts) {
    opts = opts || {};
    const icon = opts.icon || "◎";
    const esc = window.Util ? Util.escapeHtml : (s) => String(s);
    return `
      <div class="empty-state">
        <div class="empty-state-icon" aria-hidden="true">${esc(icon)}</div>
        ${opts.title ? `<div class="empty-state-title">${esc(opts.title)}</div>` : ""}
        ${opts.body ? `<div class="empty-state-body">${opts.body}</div>` : ""}
        ${opts.action || ""}
      </div>`;
  };

  /* requestAnimationFrame-batched callback, so a burst of state changes
   * repaints once. */
  Dom.raf = function (fn) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
    else setTimeout(fn, 16);
  };

  window.Dom = Dom;
})();
