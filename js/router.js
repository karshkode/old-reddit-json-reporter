/* =====================================================================
 * ROUTER
 * ---------------------------------------------------------------------
 * Owns which view is on screen. Five destinations — dashboard,
 * campaigns, communities, posts, syndicate — plus a campaign sub-route
 * (#/campaigns/<id>) so an open campaign is linkable and survives a
 * reload.
 *
 * Views render lazily: entering a view for the first time (or after its
 * data changed) calls its render hook. The previous build re-rendered
 * every pane on every data change, including eight off-screen Chart.js
 * canvases, which made each refresh cost far more than it needed to.
 *
 * Session-sync links use bare `#s=` / `#session=` fragments, so only
 * hashes beginning with `#/` are treated as routes.
 * ===================================================================== */
(function () {
  const Router = {};

  const views = new Map();
  const listeners = [];

  let current = null;      /* { name, params } */
  const dirty = new Set(); /* views needing a re-render before display */
  const mounted = new Set();

  const STORAGE_KEY = "rj.view";
  const DEFAULT_VIEW = "dashboard";

  /* Register a view.
   *   name      route segment + `view-<name>` element id
   *   title     topbar heading
   *   subtitle  topbar sub-heading (string or function(params))
   *   render    called when the view becomes visible and is dirty
   *   mount     called once, the first time the view is entered
   *   enter     called on every entry, after render
   */
  Router.register = function (name, opts) {
    views.set(name, Object.assign({ name: name }, opts || {}));
    dirty.add(name);
  };

  Router.has = function (name) {
    return views.has(name);
  };

  Router.current = function () {
    return current ? current.name : null;
  };

  Router.params = function () {
    return (current && current.params) || {};
  };

  Router.onChange = function (fn) {
    if (typeof fn === "function") listeners.push(fn);
  };

  /* Flag one or more views as needing a re-render. The active view is
   * re-rendered immediately; the rest wait until they are opened. */
  Router.invalidate = function (names) {
    const list = names == null
      ? Array.from(views.keys())
      : [].concat(names);
    for (const n of list) dirty.add(n);
    if (current && dirty.has(current.name)) renderView(current.name, current.params);
  };

  function renderView(name, params) {
    const view = views.get(name);
    if (!view) return;
    if (!mounted.has(name)) {
      mounted.add(name);
      if (typeof view.mount === "function") {
        try { view.mount(params); } catch (err) { console.warn(`[router] mount ${name}:`, err && err.message); }
      }
    }
    if (typeof view.render === "function") {
      try { view.render(params); } catch (err) { console.warn(`[router] render ${name}:`, err && err.message); }
    }
    /* Subtitles usually summarise the data ("230 posts across 3 subs"),
     * so they go stale the moment a fetch lands. Repaint on every render,
     * not just on navigation. */
    setTopbar(view, params);
    dirty.delete(name);
  }

  function setTopbar(view, params) {
    const titleEl = document.getElementById("topbar-title-text");
    const subEl = document.getElementById("topbar-title-sub");
    if (titleEl) titleEl.textContent = typeof view.title === "function" ? view.title(params) : (view.title || "");
    if (subEl) {
      const sub = typeof view.subtitle === "function" ? view.subtitle(params) : view.subtitle;
      subEl.textContent = sub || "";
      subEl.hidden = !sub;
    }
    if (document.title !== undefined) {
      const t = typeof view.title === "function" ? view.title(params) : view.title;
      document.title = t ? `${t} · Reddit Campaign Reporter` : "Reddit Campaign Reporter";
    }
  }

  function paintNav(name) {
    for (const link of document.querySelectorAll("[data-view]")) {
      const on = link.dataset.view === name;
      link.classList.toggle("active", on);
      if (link.hasAttribute("aria-current") || on) {
        if (on) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    }
  }

  function paintPanes(name) {
    for (const pane of document.querySelectorAll(".view")) {
      pane.classList.toggle("active", pane.id === "view-" + name);
    }
  }

  /* Navigate. `opts.replace` avoids pushing a history entry, `opts.silent`
   * skips the hash write (used when responding to a hashchange). */
  Router.go = function (name, params, opts) {
    opts = opts || {};
    if (!views.has(name)) name = DEFAULT_VIEW;
    params = params || {};

    const view = views.get(name);
    const changedView = !current || current.name !== name;
    const changedParams = JSON.stringify(params) !== JSON.stringify((current && current.params) || {});
    current = { name: name, params: params };

    if (!opts.silent) writeHash(name, params, opts.replace);
    try { localStorage.setItem(STORAGE_KEY, name); } catch (_) {}

    paintNav(name);
    paintPanes(name);
    setTopbar(view, params);

    if (dirty.has(name) || changedParams || !mounted.has(name)) renderView(name, params);

    if (typeof view.enter === "function") {
      try { view.enter(params); } catch (err) { console.warn(`[router] enter ${name}:`, err && err.message); }
    }

    if (changedView && !opts.keepScroll) {
      window.scrollTo({ top: 0, behavior: opts.smooth ? "smooth" : "auto" });
    }

    for (const fn of listeners) {
      try { fn(name, params); } catch (_) {}
    }
    return name;
  };

  function writeHash(name, params, replace) {
    let hash = "#/" + name;
    if (params && params.id) hash += "/" + encodeURIComponent(params.id);
    if (window.location.hash === hash) return;
    /* Never stomp a session-share fragment mid-import; app.js clears it
     * once the user has answered the merge/replace prompt. */
    const existing = window.location.hash || "";
    if (existing && !existing.startsWith("#/") && existing.length > 2) return;
    try {
      if (replace) history.replaceState(null, "", hash);
      else history.pushState(null, "", hash);
    } catch (_) {
      window.location.hash = hash;
    }
  }

  Router.parseHash = function (hash) {
    const h = String(hash || "").trim();
    if (!h.startsWith("#/")) return null;
    const parts = h.slice(2).split("/").filter(Boolean);
    if (!parts.length) return null;
    const name = decodeURIComponent(parts[0]);
    if (!views.has(name)) return null;
    const params = {};
    if (parts[1]) params.id = decodeURIComponent(parts[1]);
    return { name: name, params: params };
  };

  /* Resolve the view to open on load: explicit hash beats the persisted
   * last view, which beats the default. */
  Router.start = function () {
    const fromHash = Router.parseHash(window.location.hash);
    if (fromHash) {
      Router.go(fromHash.name, fromHash.params, { replace: true, silent: true });
    } else {
      let saved = null;
      try { saved = localStorage.getItem(STORAGE_KEY); } catch (_) {}
      Router.go(views.has(saved) ? saved : DEFAULT_VIEW, {}, { replace: true });
    }

    window.addEventListener("hashchange", () => {
      const parsed = Router.parseHash(window.location.hash);
      if (parsed) Router.go(parsed.name, parsed.params, { silent: true });
    });
    window.addEventListener("popstate", () => {
      const parsed = Router.parseHash(window.location.hash);
      if (parsed) Router.go(parsed.name, parsed.params, { silent: true });
    });
  };

  /* Wire nav rail + bottom tab bar. Any element with data-view routes. */
  Router.wireNav = function () {
    document.addEventListener("click", (e) => {
      const link = e.target && e.target.closest && e.target.closest("[data-view]");
      if (!link) return;
      e.preventDefault();
      Router.go(link.dataset.view, link.dataset.viewId ? { id: link.dataset.viewId } : {});
    });
  };

  window.Router = Router;
})();
