/* Reusable sidebar overlay component.
 *
 * Replaces the centered-modal pattern for complex sections like the
 * composer and the campaign-detail subsections. Sidebars dock to the
 * right edge on desktop and take the full viewport on mobile, so:
 *
 *   - Mobile users get the full screen for the section content
 *     instead of fighting a centered modal that's barely taller than
 *     the keyboard.
 *   - Desktop users keep the dashboard underneath visible while
 *     interacting with the section.
 *
 * Two sidebar slots in the DOM:
 *
 *   #composer-sidebar  — owned by the composer, has its own state
 *                        machine and event listeners that need to
 *                        survive across opens. Don't re-render its
 *                        innerHTML; just show/hide it.
 *
 *   #section-sidebar   — generic. Content is HTML rendered per-open
 *                        for things like "posts in this campaign",
 *                        "targeting recommendations", "deep analysis".
 *                        Closing wipes its body so the next opener
 *                        starts fresh.
 *
 * Both share the same .sidebar / .sidebar-backdrop styling.
 *
 * One sidebar at a time — opening a second auto-closes the first.
 * Backdrop click + Escape key + close button all dismiss.
 */
(function () {
  const Sidebar = {};

  let activeId = null;
  let activeOpts = null;
  let escHandlerBound = false;

  function escHandler(e) {
    if (e.key === "Escape" && activeId) Sidebar.close();
  }

  function bindEsc() {
    if (escHandlerBound) return;
    document.addEventListener("keydown", escHandler);
    escHandlerBound = true;
  }
  function unbindEsc() {
    if (!escHandlerBound) return;
    document.removeEventListener("keydown", escHandler);
    escHandlerBound = false;
  }

  /* Open a sidebar by ID. Two routing modes:
   *
   *   Sidebar.open({ id: "composer-sidebar" })
   *     Show an existing sidebar that owns its own DOM (the composer
   *     case). Title/subtitle/content are NOT rewritten — the
   *     sidebar's existing markup stays intact.
   *
   *   Sidebar.open({
   *     id: "section-sidebar",
   *     title: "Posts in this campaign",
   *     subtitle: "Seven Days in June · 3 resolved",
   *     content: "<div>…</div>",
   *     onMount: (bodyEl) => {…},   // run after DOM injected
   *     onClose: () => {…},          // run on close (any reason)
   *   })
   *     Generic mode: title + content are written into the
   *     sidebar template's slots.
   */
  Sidebar.open = function (opts) {
    if (!opts || !opts.id) return;

    /* Switching sidebars: close the prior one first so onClose
     * fires for whatever was already mounted. */
    if (activeId && activeId !== opts.id) {
      Sidebar.close();
    }

    const el = document.getElementById(opts.id);
    if (!el) {
      console.warn("[sidebar] unknown id:", opts.id);
      return;
    }

    /* Generic-mode rendering. Title + content slots are wired by
     * convention: the sidebar's HTML has [data-sidebar-title] and
     * [data-sidebar-body] elements that we populate. */
    if (opts.title != null) {
      const titleEl = el.querySelector("[data-sidebar-title]");
      if (titleEl) titleEl.textContent = String(opts.title);
    }
    if (opts.subtitle != null) {
      const subEl = el.querySelector("[data-sidebar-subtitle]");
      if (subEl) {
        subEl.textContent = String(opts.subtitle);
        subEl.hidden = !opts.subtitle;
      }
    }
    if (opts.content != null) {
      const bodyEl = el.querySelector("[data-sidebar-body]");
      if (bodyEl) bodyEl.innerHTML = String(opts.content);
    }

    el.hidden = false;
    /* Show the paired backdrop. Convention: the backdrop element's
     * id is "<sidebar-id>-backdrop" (e.g. composer-sidebar-backdrop).
     * Sidebar.close hides it again. Callers don't need to manage
     * the backdrop themselves. */
    const backdrop = document.getElementById(opts.id + "-backdrop");
    if (backdrop) backdrop.hidden = false;
    document.body.classList.add("sidebar-open");
    activeId = opts.id;
    activeOpts = opts;
    bindEsc();

    if (typeof opts.onMount === "function") {
      const bodyEl = el.querySelector("[data-sidebar-body]") || el;
      try { opts.onMount(bodyEl); } catch (e) { console.warn("[sidebar] onMount failed:", e); }
    }

    /* Move keyboard focus inside the sidebar so screen readers
     * follow and Escape works without an extra click. Defer to
     * the next frame so the sidebar is laid out first. */
    setTimeout(() => {
      const focusable = el.querySelector("[data-sidebar-body] button, [data-sidebar-body] [href], [data-sidebar-body] input, [data-sidebar-body] textarea, [data-sidebar-body] select")
        || el.querySelector("[data-sidebar-close]");
      if (focusable) focusable.focus({ preventScroll: true });
    }, 50);
  };

  Sidebar.close = function () {
    if (!activeId) return;
    const el = document.getElementById(activeId);
    if (el) el.hidden = true;
    const backdrop = document.getElementById(activeId + "-backdrop");
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove("sidebar-open");

    /* Wipe generic sidebars on close so the next open starts
     * fresh. The composer-sidebar is excluded — its DOM holds
     * state we want to preserve across opens. */
    if (el && activeId !== "composer-sidebar") {
      const bodyEl = el.querySelector("[data-sidebar-body]");
      if (bodyEl) bodyEl.innerHTML = "";
    }

    const opts = activeOpts;
    activeId = null;
    activeOpts = null;
    unbindEsc();
    if (opts && typeof opts.onClose === "function") {
      try { opts.onClose(); } catch (e) { console.warn("[sidebar] onClose failed:", e); }
    }
  };

  Sidebar.isOpen = function () { return activeId !== null; };
  Sidebar.activeId = function () { return activeId; };

  /* Single document-level click delegation for the close affordances.
   * Binds once on first open of a sidebar; unbind never (cheap).
   * Recognised attributes:
   *   data-sidebar-close     close the active sidebar
   *   data-sidebar-backdrop  same — used on the backdrop overlay  */
  if (typeof document !== "undefined") {
    document.addEventListener("click", (e) => {
      const closer = e.target.closest && e.target.closest("[data-sidebar-close], [data-sidebar-backdrop]");
      if (closer) {
        e.preventDefault();
        Sidebar.close();
      }
    });
  }

  if (typeof window !== "undefined") window.Sidebar = Sidebar;
  if (typeof module !== "undefined" && module.exports) module.exports = Sidebar;
})();
