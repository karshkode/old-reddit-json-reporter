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

  Charts.timeline = function (id, buckets) {
    const t = theme();
    const labels = buckets.map((b) => b.t.slice(5, 16).replace("T", " "));
    const data = buckets.map((b) => b.n);
    return render(id, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Posts",
          data,
          borderColor: t.accent,
          backgroundColor: hexA(t.accent, 0.18),
          fill: true,
          tension: 0.25,
          pointRadius: 2,
          pointHoverRadius: 4,
        }],
      },
      options: Object.assign(commonOpts(), {
        plugins: {
          legend: { display: false },
          tooltip: commonOpts().plugins.tooltip,
        },
      }),
    });
  };

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

  Charts.hourHeat = function (id, agg) {
    const t = theme();
    const labels = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
    return render(id, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Avg score", data: agg.avgScoreByHour, backgroundColor: hexA(t.accent, 0.7), borderColor: t.accent, yAxisID: "y" },
          { label: "Posts", data: agg.byHour, backgroundColor: hexA(t.info, 0.5), borderColor: t.info, type: "line", tension: 0.3, yAxisID: "y2", pointRadius: 0 },
        ],
      },
      options: Object.assign(commonOpts(), {
        scales: {
          x: commonOpts().scales.x,
          y: { ...commonOpts().scales.y, position: "left", title: { display: true, text: "avg score", color: t.mute } },
          y2: { ...commonOpts().scales.y, position: "right", grid: { display: false }, title: { display: true, text: "post count", color: t.mute } },
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

  window.Charts = Charts;
})();
