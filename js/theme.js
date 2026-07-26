/* =====================================================================
 * THEME
 * ---------------------------------------------------------------------
 * Sets [data-theme] on <html> from the persisted preference and cycles
 * between system / dark / light. Runs before first paint (the script tag
 * sits in <head>) so there is no flash of the wrong palette.
 *
 * Chart.js reads its colours from CSS custom properties at render time
 * (see Charts.theme), so switching the attribute is enough for canvases
 * to follow once they are redrawn — Theme.onChange lets the app trigger
 * that redraw.
 * ===================================================================== */
(function () {
  const KEY = "rj.theme";
  const ORDER = ["system", "dark", "light"];
  const LABEL = { system: "System", dark: "Dark", light: "Light" };
  const ICON = { system: "◐", dark: "☾", light: "☀" };

  const Theme = {};
  const listeners = [];

  function read() {
    try {
      const v = localStorage.getItem(KEY);
      return ORDER.indexOf(v) >= 0 ? v : "system";
    } catch (_) {
      return "system";
    }
  }

  Theme.get = read;

  Theme.set = function (mode) {
    const next = ORDER.indexOf(mode) >= 0 ? mode : "system";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(KEY, next); } catch (_) {}
    syncMetaColor();
    for (const fn of listeners) {
      try { fn(next); } catch (_) {}
    }
    return next;
  };

  Theme.cycle = function () {
    const i = ORDER.indexOf(read());
    return Theme.set(ORDER[(i + 1) % ORDER.length]);
  };

  Theme.label = function (mode) {
    return LABEL[mode || read()] || "System";
  };

  Theme.icon = function (mode) {
    return ICON[mode || read()] || "◐";
  };

  Theme.resolved = function () {
    const mode = read();
    if (mode !== "system") return mode;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  };

  Theme.onChange = function (fn) {
    if (typeof fn === "function") listeners.push(fn);
  };

  /* Keep the browser chrome colour in step with the resolved palette. */
  function syncMetaColor() {
    const dark = Theme.resolved() === "dark";
    const color = dark ? "#0a0c11" : "#f4f6fb";
    let meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", color);
  }

  /* Apply immediately so there is no flash. */
  document.documentElement.setAttribute("data-theme", read());

  /* When following the OS, react to OS changes so charts recolour. */
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onOsChange = () => {
      if (read() !== "system") return;
      syncMetaColor();
      for (const fn of listeners) {
        try { fn("system"); } catch (_) {}
      }
    };
    if (mq.addEventListener) mq.addEventListener("change", onOsChange);
    else if (mq.addListener) mq.addListener(onOsChange);
  }

  if (document.head) syncMetaColor();

  window.Theme = Theme;
})();
