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

  /* ---------------------------------------------------------------
   * Section rails
   * ---------------------------------------------------------------
   * The dashboard, the campaign workspace and the communities view all
   * present the same widget: a strip of tabs where only the selected
   * panel is in the document flow. Keeping that logic here means one
   * implementation of the ARIA contract instead of three drifting
   * copies, and it is what keeps these views to a screen or two on a
   * phone rather than one continuous scroll.
   *
   * `rail` is the nav's id, `attr` the dataset key its buttons carry
   * (e.g. "dash-tab"), and `panelPrefix` the id prefix of the panels,
   * so a tab keyed `charts` drives the panel `dash-charts`.
   * -------------------------------------------------------------- */

  function railButtons(nav, attr) {
    return Dom.$$("[data-" + attr + "]", nav);
  }

  Dom.paintRail = function (rail, attr, active, panelPrefix, panelSelector) {
    const nav = Dom.byId(rail);
    const key = camel(attr);
    if (nav) {
      for (const btn of railButtons(nav, attr)) {
        const on = btn.dataset[key] === active;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
        /* Roving tabindex: one tab stop for the whole strip, arrow keys
         * move between tabs. Dom.wireRail supplies the arrow keys. */
        btn.tabIndex = on ? 0 : -1;
      }
    }
    for (const panel of Dom.$$(panelSelector)) {
      panel.classList.toggle("active", panel.id === panelPrefix + active);
    }
  };

  /* Click and keyboard wiring for a rail. `onSelect` receives the tab
   * key. Delegated from the document so it survives re-renders. */
  Dom.wireRail = function (rail, attr, onSelect) {
    const key = camel(attr);
    const sel = "#" + rail + " [data-" + attr + "]";

    Dom.delegate(document, "click", sel, (e, btn) => {
      e.preventDefault();
      onSelect(btn.dataset[key]);
    });

    Dom.delegate(document, "keydown", sel, (e, btn) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      const nav = btn.closest("#" + rail);
      if (!nav) return;
      const tabs = railButtons(nav, attr);
      let next = null;
      if (step) next = tabs[(tabs.indexOf(btn) + step + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (!next) return;
      e.preventDefault();
      onSelect(next.dataset[key]);
      next.focus();
    });
  };

  /* A rail scrolls horizontally on a phone, so the tab just selected can
   * sit off screen — after a jump from a button elsewhere in the view,
   * for instance. Bring it back without yanking the page vertically. */
  Dom.revealRailTab = function (rail, attr, active) {
    const nav = Dom.byId(rail);
    if (!nav || nav.scrollWidth <= nav.clientWidth + 4) return;
    const btn = Dom.$("[data-" + attr + '="' + active + '"]', nav);
    if (btn && btn.scrollIntoView) {
      btn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  };

  /* ---------------------------------------------------------------
   * Overflow menus
   * ---------------------------------------------------------------
   * Secondary actions collapse behind a "⋯" toggle at narrow widths.
   * Whether the list is a row or a popover is entirely a CSS decision;
   * this only tracks which menu is open. Call once at startup.
   * -------------------------------------------------------------- */
  Dom.wireActionMenus = function () {
    function closeAll(except) {
      for (const menu of Dom.$$(".action-menu.open")) {
        if (menu === except) continue;
        menu.classList.remove("open");
        const toggle = Dom.$(".action-menu-toggle", menu);
        if (toggle) toggle.setAttribute("aria-expanded", "false");
      }
    }

    Dom.delegate(document, "click", ".action-menu-toggle", (e, btn) => {
      e.preventDefault();
      const menu = btn.closest(".action-menu");
      if (!menu) return;
      closeAll(menu);
      const open = menu.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });

    /* Anything else closes: picking an action, or tapping away. Both
     * listeners sit on document, so the toggle needs excluding by hand
     * rather than by stopping propagation. */
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.closest && t.closest(".action-menu-toggle")) return;
      closeAll();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAll();
    });
  };

  function camel(s) {
    return String(s).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  /* requestAnimationFrame-batched callback, so a burst of state changes
   * repaints once. */
  Dom.raf = function (fn) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
    else setTimeout(fn, 16);
  };

  window.Dom = Dom;
})();
