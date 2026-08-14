/* Chart.js wrappers. Each render function lazily creates or replaces a chart
 * bound to the given canvas id. Charts use a shared theme that matches the
 * app's CSS variables.
 */
(function () {
  const Charts = {};
  const instances = {};

  function theme() {
    const cs = getComputedStyle(document.documentElement);
    return {
      text: cs.getPropertyValue("--text").trim() || "#e6ebf5",
      dim: cs.getPropertyValue("--text-dim").trim() || "#9aa6bd",
      mute: cs.getPropertyValue("--text-mute").trim() || "#6b7793",
      grid: cs.getPropertyValue("--border").trim() || "#232a3a",
      accent: cs.getPropertyValue("--accent").trim() || "#ff5722",
      accent2: cs.getPropertyValue("--accent-2").trim() || "#ffa64d",
      good: cs.getPropertyValue("--good").trim() || "#34d399",
      bad: cs.getPropertyValue("--bad").trim() || "#f87171",
      info: cs.getPropertyValue("--info").trim() || "#60a5fa",
      warn: cs.getPropertyValue("--warn").trim() || "#fbbf24",
    };
  }

  function commonOpts() {
    const t = theme();
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: t.dim, font: { size: 11 } } },
        tooltip: {
          backgroundColor: "rgba(20, 25, 40, 0.95)",
          titleColor: t.text,
          bodyColor: t.dim,
          borderColor: t.grid,
          borderWidth: 1,
        },
      },
      scales: {
        x: { ticks: { color: t.mute, font: { size: 10 } }, grid: { color: t.grid, drawBorder: false } },
        y: { ticks: { color: t.mute, font: { size: 10 } }, grid: { color: t.grid, drawBorder: false } },
      },
    };
  }

  function render(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    if (typeof Chart === "undefined") {
      canvas.replaceWith(Object.assign(document.createElement("div"), { className: "empty", textContent: "Charts library failed to load." }));
      return null;
    }
    if (instances[id]) {
      instances[id].destroy();
      delete instances[id];
    }
    instances[id] = new Chart(canvas.getContext("2d"), config);
    return instances[id];
  }

  /* Distinct, readable colours for up to 12 subreddits before the
   * sequence wraps. The first three match the app's accent / info /
   * good tokens so the most-active sub uses the brand orange. */
  const SUB_PALETTE = [
    "#ff5722", "#60a5fa", "#34d399", "#fbbf24", "#f87171", "#a78bfa",
    "#22d3ee", "#f472b6", "#84cc16", "#fb923c", "#06b6d4", "#e879f9",
  ];
  function paletteAt(i) { return SUB_PALETTE[i % SUB_PALETTE.length]; }

  /* Timeline accepts either:
   *   - the legacy [{t,n}] from Analysis.bucketByHour (plotted as Total)
   *   - the new {keys, total, bySub, subs, bucketS, bucketLabel} from
   *     Analysis.bucketByTimePerSub (plotted as Per-sub / Stacked / Total
   *     depending on opts.mode).
   */
  Charts.timeline = function (id, data, opts) {
    const t = theme();
    opts = opts || {};
    const mode = opts.mode || "lines";

    /* Legacy shape -> single-line Total chart */
    if (Array.isArray(data)) {
      const labels = data.map((b) => b.t.slice(5, 16));
      const series = data.map((b) => b.n);
      return render(id, {
        type: "line",
        data: { labels, datasets: [{
          label: "Posts", data: series,
          borderColor: t.accent, backgroundColor: hexA(t.accent, 0.18),
          fill: true, tension: 0.25, pointRadius: 1, pointHoverRadius: 4,
        }]},
        options: Object.assign(commonOpts(), {
          plugins: { legend: { display: false }, tooltip: commonOpts().plugins.tooltip },
          scales: timelineScales(t, labels.length),
        }),
      });
    }

    const keys = data && data.keys ? data.keys : [];
    if (!keys.length) {
      return render(id, {
        type: "line",
        data: { labels: ["—"], datasets: [{ data: [0], borderColor: t.mute }] },
        options: Object.assign(commonOpts(), { plugins: { legend: { display: false } } }),
      });
    }

    let datasets;
    if (mode === "total") {
      const subs = data.subs || [];
      datasets = [{
        label: subs.length === 1 ? "Posts in r/" + subs[0] : "Posts (all subs)",
        data: data.total,
        borderColor: t.accent, backgroundColor: hexA(t.accent, 0.20),
        fill: true, tension: 0.25, pointRadius: 1, pointHoverRadius: 4,
      }];
    } else if (mode === "stacked") {
      datasets = data.subs.map((sub, i) => ({
        label: "r/" + sub,
        data: data.bySub[sub],
        borderColor: paletteAt(i),
        backgroundColor: hexA(paletteAt(i), 0.45),
        borderWidth: 1,
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 3,
        stack: "subs",
      }));
    } else if (mode === "density") {
      /* Each sub's series normalised to its own peak (0..1). Lets the
       * user compare cadence shapes across subs without volume-bias —
       * a sub posting 2/day and a sub posting 200/day both top out at
       * 1.0 so they overlay properly. */
      datasets = data.subs.map((sub, i) => {
        const series = data.bySub[sub];
        const peak = Math.max(1, ...series);
        return {
          label: "r/" + sub,
          data: series.map((v) => v / peak),
          borderColor: paletteAt(i),
          backgroundColor: hexA(paletteAt(i), 0.06),
          borderWidth: 2,
          fill: false,
          tension: 0.30,
          pointRadius: 0,
          pointHoverRadius: 4,
        };
      });
    } else {
      /* "lines" — per-sub overlay, no stacking */
      datasets = data.subs.map((sub, i) => ({
        label: "r/" + sub,
        data: data.bySub[sub],
        borderColor: paletteAt(i),
        backgroundColor: hexA(paletteAt(i), 0.10),
        borderWidth: 2,
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 4,
      }));
    }

    const stacked = mode === "stacked";
    const isDensity = mode === "density";
    return render(id, {
      type: "line",
      data: { labels: keys, datasets },
      options: Object.assign(commonOpts(), {
        plugins: {
          legend: {
            display: data.subs.length <= 12,
            position: "bottom",
            labels: { color: t.dim, font: { size: 10 }, boxWidth: 8, boxHeight: 8 },
          },
          tooltip: commonOpts().plugins.tooltip,
        },
        scales: timelineScales(t, keys.length, stacked, { density: isDensity }),
        interaction: { mode: "index", intersect: false },
      }),
    });
  };

  /* Reduce x-axis tick clutter on dense or narrow charts and respect
   * stacking when requested. */
  function timelineScales(t, n, stacked, opts) {
    const maxTicks = n > 60 ? 8 : n > 30 ? 10 : 14;
    return {
      x: { ...commonOpts().scales.x,
           ticks: { ...commonOpts().scales.x.ticks, maxTicksLimit: maxTicks, autoSkip: true } },
      y: opts && opts.density ? {
        ...commonOpts().scales.y, beginAtZero: true, max: 1,
        ticks: { ...commonOpts().scales.y.ticks,
                 callback: (v) => Math.round(v * 100) + "%" },
      } : {
        ...commonOpts().scales.y, beginAtZero: true, stacked: !!stacked,
        ticks: { ...commonOpts().scales.y.ticks, precision: 0 },
      },
    };
  }

  Charts.scatter = function (id, posts) {
    const t = theme();
    const data = posts.map((p) => ({
      x: p.num_comments || 0,
      y: p.score || 0,
      title: p.title,
      sub: p.subreddit,
      id: p.id,
    }));
    return render(id, {
      type: "scatter",
      data: {
        datasets: [{
          label: "Posts",
          data,
          backgroundColor: hexA(t.accent, 0.55),
          borderColor: t.accent,
          pointRadius: 4,
          pointHoverRadius: 6,
        }],
      },
      options: Object.assign(commonOpts(), {
        plugins: {
          legend: { display: false },
          tooltip: {
            ...commonOpts().plugins.tooltip,
            callbacks: {
              label: (ctx) => {
                const r = ctx.raw || {};
                return [`r/${r.sub}`, `${(r.title || "").slice(0, 70)}`, `score ${r.y} · comments ${r.x}`];
              },
            },
          },
        },
        scales: {
          x: { ...commonOpts().scales.x, title: { display: true, text: "comments", color: t.mute } },
          y: { ...commonOpts().scales.y, title: { display: true, text: "score", color: t.mute } },
        },
      }),
    });
  };

  Charts.subCompare = function (id, agg) {
    const t = theme();
    const subs = Object.keys(agg.bySubreddit);
    const score = subs.map((s) => agg.bySubreddit[s].score);
    const comments = subs.map((s) => agg.bySubreddit[s].comments);
    return render(id, {
      type: "bar",
      data: {
        labels: subs.map((s) => "r/" + s),
        datasets: [
          { label: "Score", data: score, backgroundColor: hexA(t.accent, 0.7), borderColor: t.accent },
          { label: "Comments", data: comments, backgroundColor: hexA(t.info, 0.6), borderColor: t.info },
        ],
      },
      options: commonOpts(),
    });
  };

  Charts.histogram = function (id, hist) {
    const t = theme();
    return render(id, {
      type: "bar",
      data: {
        labels: hist.labels,
        datasets: [{
          label: "Posts",
          data: hist.counts,
          backgroundColor: hexA(t.accent2, 0.7),
          borderColor: t.accent2,
        }],
      },
      options: Object.assign(commonOpts(), {
        plugins: { legend: { display: false }, tooltip: commonOpts().plugins.tooltip },
      }),
    });
  };

  /* opts.compact drops the legend and the axis titles. Used for the
   * per-subreddit small multiples, where a dozen copies of the same
   * legend crowd out the bars they are labelling. */
  Charts.hourHeat = function (id, agg, opts) {
    opts = opts || {};
    const t = theme();
    const base = commonOpts();
    const labels = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
    const axisTitle = (text) => (opts.compact ? { display: false } : { display: true, text: text, color: t.mute });
    const options = Object.assign(base, {
      scales: {
        x: Object.assign({}, base.scales.x, opts.compact ? { ticks: Object.assign({}, base.scales.x.ticks, { maxTicksLimit: 8 }) } : {}),
        y: { ...base.scales.y, position: "left", title: axisTitle("avg score") },
        y2: { ...base.scales.y, position: "right", grid: { display: false }, title: axisTitle("post count") },
      },
    });
    if (opts.compact) {
      options.plugins = Object.assign({}, options.plugins, {
        legend: Object.assign({}, (options.plugins || {}).legend, { display: false }),
      });
    }
    return render(id, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Avg score", data: agg.avgScoreByHour, backgroundColor: hexA(t.accent, 0.7), borderColor: t.accent, yAxisID: "y" },
          { label: "Posts", data: agg.byHour, backgroundColor: hexA(t.info, 0.5), borderColor: t.info, type: "line", tension: 0.3, yAxisID: "y2", pointRadius: 0 },
        ],
      },
      options: options,
    });
  };

  /* The fitted posting-time curve against the posts it was fitted to.
   *
   * The hour-by-hour bar chart this replaces plotted mean score per
   * hour, which is precisely the quantity the estimator was rewritten
   * to stop trusting: one breakout post produced a bar four times the
   * height of every honest hour. A reader comparing that chart with
   * the recommendation underneath would reasonably conclude the
   * recommendation was wrong.
   *
   * So the chart now shows what the model actually claims — a smooth
   * curve of the typical post through the day — over a scatter of
   * every post on a log scale. The breakout is still visible, sitting
   * far above a curve that barely acknowledges it, which is the whole
   * argument in one picture. The recommended window is the segment
   * drawn in accent colour. */
  function axisTitle(opts, text, t) {
    return {
      display: true,
      text: text,
      color: t.mute,
      font: { size: opts.compact ? 9 : 11 },
      padding: opts.compact ? 0 : 4,
    };
  }

  Charts.timingCurve = function (id, row, opts) {
    opts = opts || {};
    const t = theme();
    const fit = row && row.fit;
    if (!fit || !fit.curveScores) return Charts.hourHeat(id, row.agg, opts);

    const slots = fit.curveScores.length;
    const curve = fit.curveScores.map((v, i) => ({ x: (i * 24) / slots, y: Math.max(0.5, v) }));
    /* Close the loop so the line does not stop short of midnight. */
    curve.push({ x: 24, y: Math.max(0.5, fit.curveScores[0]) });

    const baseline = Math.max(0.5, Math.expm1(fit.grandLog));
    /* Prefer the (possibly availability-constrained) window on the row
     * so the accent segment matches the times the UI is recommending. */
    const win = (row.window && row.window.slots) ? row.window : fit.window;
    const winStart = win.start / 60;
    const winEnd = (win.end === 0 && win.start > 0) ? 24 : win.end / 60;
    const wraps = winEnd <= winStart;
    const inWindow = (h) => (wraps ? (h >= winStart || h <= winEnd) : (h >= winStart && h <= winEnd));

    const avail = row.availability || opts.availability || null;
    const hasAvail = avail && window.Timing && !Timing.isAllDay(avail);
    const availStart = hasAvail ? avail.start / 60 : 0;
    const availEnd = hasAvail ? (avail.end >= 1440 ? 24 : avail.end / 60) : 24;
    const inAvail = (h) => {
      if (!hasAvail) return true;
      return h >= availStart && h <= availEnd;
    };

    const points = fit.points.map((p) => ({ x: p.x, y: p.y }));
    const capped = fit.points.some((p) => p.capped);

    const base = commonOpts();
    return render(id, {
      type: "scatter",
      data: {
        datasets: [
          {
            label: capped ? "Posts (runaway scores capped)" : "Posts",
            data: points,
            showLine: false,
            pointRadius: 2,
            pointHoverRadius: 4,
            backgroundColor: hexA(t.info, 0.45),
            borderColor: "transparent",
          },
          {
            label: "Typical post",
            data: curve,
            showLine: true,
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.3,
            borderColor: t.mute,
            segment: {
              borderColor: (ctx) => {
                const x0 = ctx.p0.parsed.x, x1 = ctx.p1.parsed.x;
                if (inWindow(x0) && inWindow(x1)) return t.accent;
                if (hasAvail && (!inAvail(x0) || !inAvail(x1))) return hexA(t.mute, 0.35);
                return t.mute;
              },
              borderWidth: (ctx) => (inWindow(ctx.p0.parsed.x) && inWindow(ctx.p1.parsed.x) ? 3 : 2),
            },
          },
          {
            label: "This community's baseline",
            data: [{ x: 0, y: baseline }, { x: 24, y: baseline }],
            showLine: true,
            pointRadius: 0,
            borderWidth: 1,
            borderDash: [4, 4],
            borderColor: hexA(t.dim, 0.7),
          },
        ],
      },
      options: Object.assign(base, {
        plugins: Object.assign({}, base.plugins, {
          legend: { display: !opts.compact, labels: { color: t.dim, font: { size: 10 }, boxWidth: 10 } },
          tooltip: Object.assign({}, base.plugins.tooltip, {
            callbacks: {
              label: (c) => {
                const h = Math.floor(c.parsed.x);
                const m = Math.round((c.parsed.x - h) * 60);
                const at = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
                const n = Math.round(c.parsed.y);
                if (c.datasetIndex === 0) return `${at} — a post scoring ${n}`;
                if (c.datasetIndex === 1) return `${at} — a typical post scores ${n}`;
                return `all day — this community averages ${n}`;
              },
            },
          }),
        }),
        scales: {
          x: Object.assign({}, base.scales.x, {
            type: "linear", min: 0, max: 24,
            ticks: Object.assign({}, base.scales.x.ticks, {
              stepSize: opts.compact ? 6 : 3,
              callback: (v) => String(v).padStart(2, "0"),
            }),
            /* Labelled even on the small multiples. Unlabelled axes
             * were read as "upvotes over time" rather than "upvotes by
             * time of day", which inverts what the chart says. */
            title: axisTitle(opts, "hour of day", t),
          }),
          y: Object.assign({}, base.scales.y, {
            type: "logarithmic",
            title: axisTitle(opts, "upvotes", t),
          }),
        },
      }),
    });
  };

  Charts.dow = function (id, agg) {
    const t = theme();
    const labels = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    return render(id, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Posts",
          data: agg.byDow,
          backgroundColor: hexA(t.info, 0.7),
          borderColor: t.info,
        }],
      },
      options: Object.assign(commonOpts(), {
        plugins: { legend: { display: false }, tooltip: commonOpts().plugins.tooltip },
      }),
    });
  };

  Charts.velocity = function (id, posts) {
    const t = theme();
    const sorted = posts
      .filter((p) => p.created_utc)
      .sort((a, b) => b.created_utc - a.created_utc)
      .slice(0, 30)
      .reverse();
    const labels = sorted.map((p) => Util.fmtDateShort(p.created_utc));
    const score = sorted.map((p) => p.score || 0);
    const comments = sorted.map((p) => p.num_comments || 0);
    return render(id, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Score", data: score, borderColor: t.accent, backgroundColor: hexA(t.accent, 0.15), fill: false, tension: 0.25, pointRadius: 2, yAxisID: "y" },
          { label: "Comments", data: comments, borderColor: t.info, backgroundColor: hexA(t.info, 0.15), fill: false, tension: 0.25, pointRadius: 2, yAxisID: "y2" },
        ],
      },
      options: Object.assign(commonOpts(), {
        scales: {
          x: commonOpts().scales.x,
          y: { ...commonOpts().scales.y, position: "left", title: { display: true, text: "score", color: t.mute } },
          y2: { ...commonOpts().scales.y, position: "right", grid: { display: false }, title: { display: true, text: "comments", color: t.mute } },
        },
      }),
    });
  };

  Charts.sentiment = function (id, sent) {
    const t = theme();
    return render(id, {
      type: "doughnut",
      data: {
        labels: ["Positive", "Neutral", "Negative"],
        datasets: [{
          data: [sent.positive, sent.neutral, sent.negative],
          backgroundColor: [hexA(t.good, 0.8), hexA(t.mute, 0.6), hexA(t.bad, 0.8)],
          borderColor: ["transparent", "transparent", "transparent"],
        }],
      },
      options: Object.assign(commonOpts(), {
        scales: {},
        cutout: "60%",
        plugins: {
          legend: { position: "bottom", labels: { color: t.dim } },
          tooltip: commonOpts().plugins.tooltip,
        },
      }),
    });
  };

  function hexA(hex, alpha) {
    if (!hex) return "rgba(255,87,34," + alpha + ")";
    let h = hex.trim().replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  Charts.destroyAll = function () {
    for (const k of Object.keys(instances)) {
      instances[k].destroy();
      delete instances[k];
    }
  };

  /* ==================================================================
   * DYNAMIC CANVASES
   * ------------------------------------------------------------------
   * The static dashboard canvases are addressed by a fixed id, which is
   * fine because they are never removed from the DOM. Per-subreddit
   * campaign panels are different: their canvases are created and
   * destroyed as the user opens campaigns, so a chart instance whose
   * canvas has been detached would leak until the page reloads.
   *
   * destroyIn() drops every instance whose canvas is no longer attached
   * to the document, or lives inside the container being replaced.
   * Callers should invoke it immediately before re-rendering a
   * container full of canvases.
   * ================================================================== */

  Charts.destroyIn = function (container) {
    const host = typeof container === "string" ? document.getElementById(container) : container;
    for (const id of Object.keys(instances)) {
      const inst = instances[id];
      const canvas = inst && inst.canvas;
      const detached = !canvas || !document.body.contains(canvas);
      const inside = host && canvas && host.contains(canvas);
      if (detached || inside) {
        try { inst.destroy(); } catch (_) {}
        delete instances[id];
      }
    }
  };

  /* Render a chart into an arbitrary canvas element (or a container we
   * should create one inside). Returns the canvas id so callers can
   * address it later. `spec` is { kind, data, opts } where kind names
   * one of the Charts.* renderers. */
  let seq = 0;
  Charts.mount = function (target, spec) {
    const host = typeof target === "string" ? document.getElementById(target) : target;
    if (!host || !spec || !spec.kind) return null;
    let canvas = host.tagName === "CANVAS" ? host : host.querySelector("canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      host.appendChild(canvas);
    }
    if (!canvas.id) canvas.id = "chart-dyn-" + (++seq);
    const fn = Charts[spec.kind];
    if (typeof fn !== "function") {
      console.warn("[charts] unknown kind:", spec.kind);
      return null;
    }
    try {
      fn(canvas.id, spec.data, spec.opts);
    } catch (err) {
      console.warn(`[charts] mount ${spec.kind}:`, err && err.message);
      return null;
    }
    return canvas.id;
  };

  /* A compact sparkline for inline use — no axes, no legend, just the
   * shape of a series. Used on the per-subreddit campaign cards where a
   * full chart would drown out the numbers beside it. */
  Charts.spark = function (id, series, opts) {
    opts = opts || {};
    const t = theme();
    const color = opts.color || t.accent;
    const values = (series || []).map((v) => Number(v) || 0);
    return render(id, {
      type: "line",
      data: {
        labels: values.map((_, i) => i),
        datasets: [{
          data: values,
          borderColor: color,
          backgroundColor: hexA(color, 0.18),
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.35,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
        animation: false,
      },
    });
  };

  /* Horizontal bar comparison, used for "which subreddit carried this
   * campaign". Chart.js calls this indexAxis: 'y'. */
  Charts.hbar = function (id, data, opts) {
    opts = opts || {};
    const t = theme();
    const labels = (data && data.labels) || [];
    const values = (data && data.values) || [];
    const secondary = data && data.secondary;
    const datasets = [{
      label: opts.label || "Upvotes",
      data: values,
      backgroundColor: hexA(t.accent, 0.75),
      borderRadius: 4,
      borderSkipped: false,
    }];
    if (secondary) {
      datasets.push({
        label: opts.secondaryLabel || "Comments",
        data: secondary,
        backgroundColor: hexA(t.info, 0.7),
        borderRadius: 4,
        borderSkipped: false,
      });
    }
    const base = commonOpts();
    return render(id, {
      type: "bar",
      data: { labels: labels, datasets: datasets },
      options: Object.assign(base, {
        indexAxis: "y",
        plugins: Object.assign(base.plugins, {
          legend: { display: !!secondary, labels: { color: t.dim, font: { size: 11 } } },
        }),
        scales: {
          x: { beginAtZero: true, ticks: { color: t.mute, font: { size: 10 } }, grid: { color: t.grid, drawBorder: false } },
          y: { ticks: { color: t.dim, font: { size: 11 } }, grid: { display: false } },
        },
      }),
    });
  };

  window.Charts = Charts;
})();
