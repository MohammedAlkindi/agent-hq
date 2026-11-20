"use strict";
// Performance view: the panels of the SigNoz Claude Agent SDK dashboard, from /api/perf.
// Single-series charts in the accent colour, one value axis each, hover tooltips on every mark.
// Loaded before the page's main script; it calls these functions once its helpers exist.

const PERF = { range: localStorage.getItem("hq-range") || "6h", sid: "", data: null, busy: false, at: 0, built: false };

const money = (v) => (v >= 100 ? "$" + Math.round(v).toLocaleString() : v >= 1 ? "$" + v.toFixed(2) : v > 0 ? "$" + v.toFixed(3) : "$0");
const pctf = (v) => (v * 100).toFixed(v < 0.1 ? 1 : 0) + "%";

function niceScale(max) {
  if (!(max > 0)) return { step: 1, top: 4 };
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  return { step, top: Math.ceil(max / step) * step };
}
function tickLabel(t, stepMs) {
  const d = new Date(t);
  return stepMs >= 3600e3 ? d.toLocaleTimeString([], { hour: "numeric" }) : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Columns: thin bars with a 2px gap, rounded data end, anchored to the baseline.
function colChart(host, rows, val, o) {
  const W = 520, H = 168, pl = 46, pr = 8, pt = 10, pb = 22, n = rows.length;
  const { step, top } = niceScale(Math.max(...rows.map(val), 0));
  const y = (v) => pt + (H - pt - pb) * (1 - v / top);
  const bw = (W - pl - pr) / n, every = Math.ceil(n / 6);
  let g = "";
  for (let v = 0; v <= top + 1e-9; v += step) g += `<line class="gl" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${pl - 6}" y="${y(v) + 3}" text-anchor="end">${o.axis(v)}</text>`;
  rows.forEach((r, i) => {
    const v = val(r), x = pl + i * bw + 1, w = Math.max(2, bw - 2), yy = y(v), hh = H - pb - yy, rad = Math.min(4, hh, w / 2);
    if (v > 0) g += `<path class="col" data-i="${i}" d="M${x},${H - pb} V${yy + rad} Q${x},${yy} ${x + rad},${yy} H${x + w - rad} Q${x + w},${yy} ${x + w},${yy + rad} V${H - pb} Z"/>`;
    g += `<rect class="hit" data-i="${i}" x="${x - 1}" y="${pt}" width="${bw}" height="${H - pt - pb}"/>`;
    if (i % every === 0) g += `<text class="ax" x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${tickLabel(r.t, PERF.data.step)}</text>`;
  });
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.label}">${g}</svg>`;
  host.querySelectorAll(".hit").forEach((el) => {
    const i = +el.dataset.i, bar = host.querySelector(`.col[data-i="${i}"]`);
    el.addEventListener("mousemove", (e) => { if (bar) bar.classList.add("on"); showTip(e, o.tip(rows[i])); });
    el.addEventListener("mouseleave", () => { if (bar) bar.classList.remove("on"); hideTip(); });
  });
}

// Line with a crosshair: 2px stroke, gaps where a bucket had no calls, an 8px marker on hover.
function lineChart(host, rows, val, o) {
  const W = 520, H = 168, pl = 46, pr = 8, pt = 10, pb = 22, n = rows.length;
  const { step, top } = niceScale(Math.max(...rows.map((r) => val(r) || 0), 0));
  const y = (v) => pt + (H - pt - pb) * (1 - v / top);
  const bw = (W - pl - pr) / n, xc = (i) => pl + i * bw + bw / 2, every = Math.ceil(n / 6);
  let g = "", d = "", pen = false;
  for (let v = 0; v <= top + 1e-9; v += step) g += `<line class="gl" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${pl - 6}" y="${y(v) + 3}" text-anchor="end">${o.axis(v)}</text>`;
  rows.forEach((r, i) => {
    const v = val(r);
    if (v > 0) {
      d += (pen ? " L" : " M") + xc(i) + "," + y(v);
      const lone = !(i > 0 && val(rows[i - 1]) > 0) && !(i < n - 1 && val(rows[i + 1]) > 0);
      if (lone) g += `<circle class="pt" cx="${xc(i)}" cy="${y(v)}" r="2.5"/>`;
      pen = true;
    } else pen = false;
    if (i % every === 0) g += `<text class="ax" x="${xc(i)}" y="${H - 6}" text-anchor="middle">${tickLabel(r.t, PERF.data.step)}</text>`;
  });
  g += `<path class="ln" d="${d}"/><line class="xh" x1="0" x2="0" y1="${pt}" y2="${H - pb}" visibility="hidden"/><circle class="mk" r="4" visibility="hidden"/>`;
  g += `<rect class="hit" x="${pl}" y="${pt}" width="${W - pl - pr}" height="${H - pt - pb}"/>`;
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.label}">${g}</svg>`;
  const sv = host.querySelector("svg"), xh = sv.querySelector(".xh"), mk = sv.querySelector(".mk");
  sv.querySelector(".hit").addEventListener("mousemove", (e) => {
    const r = sv.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width);
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - pl) / bw))), v = val(rows[i]);
    xh.setAttribute("x1", xc(i)); xh.setAttribute("x2", xc(i)); xh.setAttribute("visibility", "visible");
    if (v > 0) { mk.setAttribute("cx", xc(i)); mk.setAttribute("cy", y(v)); mk.setAttribute("visibility", "visible"); } else mk.setAttribute("visibility", "hidden");
    showTip(e, o.tip(rows[i]));
  });
  sv.querySelector(".hit").addEventListener("mouseleave", () => { xh.setAttribute("visibility", "hidden"); mk.setAttribute("visibility", "hidden"); hideTip(); });
}

function hbarList(host, rows, val, o) {
  const mx = Math.max(1e-9, ...rows.map(val));
  put(host, ...(rows.length ? rows.map((r) => {
    const row = h("div", { class: "hb" + (o.click ? " click" : ""), role: o.click ? "button" : null, tabindex: o.click ? "0" : null },
      h("span", { class: "n", text: o.name(r) }), h("span", { class: "t" }, h("i", { style: { width: Math.max(2, 100 * val(r) / mx) + "%" } })),
      h("span", { class: "v", text: o.fmt(val(r)) }));
    row.addEventListener("mousemove", (e) => showTip(e, o.tip(r)));
    row.addEventListener("mouseleave", hideTip);
    if (o.click) { row.addEventListener("click", () => o.click(r)); row.addEventListener("keydown", (e) => { if (e.key === "Enter") o.click(r); }); }
    return row;
  }) : [h("div", { class: "note", text: "Nothing in this time range." })]));
}

function perfBuild() {
  if (PERF.built) return;
  PERF.built = true;
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Time range" });
  for (const r of ["1h", "6h", "24h"]) seg.append(h("button", { type: "button", "data-r": r, "aria-pressed": String(r === PERF.range), onclick: () => {
    PERF.range = r; localStorage.setItem("hq-range", r);
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.r === r)));
    perfLoad(true);
  } }, "Last " + r));
  const sel = h("select", { id: "perf-agent", "aria-label": "Agent", onchange: (e) => { PERF.sid = e.target.value; perfLoad(true); } }, h("option", { value: "", text: "All agents" }));
  put($("#perf-filters"), seg, sel, h("span", { class: "upd", id: "perf-upd" }));
}

async function perfLoad(force) {
  perfBuild();
  if (PERF.busy || (!force && Date.now() - PERF.at < 10e3)) return;
  PERF.busy = true;
  try {
    const r = await fetch(`/api/perf?range=${PERF.range}&sid=${encodeURIComponent(PERF.sid)}`, { cache: "no-store" });
    if (r.ok) { PERF.data = await r.json(); PERF.at = Date.now(); perfRender(); }
  } catch {} finally { PERF.busy = false; }
}

function perfRender() {
  const p = PERF.data;
  if (!p) return;
  const kp = p.kpi;
  // agent filter keeps the agents seen in the last poll
  const sel = $("#perf-agent");
  if (sel && D) {
    const want = D.sessions.filter((s) => s.metrics && (s.metrics.reqs || s.metrics.toolN)).map((s) => [s.id, s.title]);
    const have = [...sel.options].slice(1).map((o) => o.value).join("|");
    if (have !== want.map((w) => w[0]).join("|")) {
      put(sel, h("option", { value: "", text: "All agents" }), ...want.map(([id, t]) => h("option", { value: id, text: t })));
      sel.value = PERF.sid;
    }
  }
  $("#perf-upd").textContent = "Updated " + clock(p.to);
  const tile = (l, v, s, st) => h("div", { class: "mt" }, h("div", { class: "l" }, st ? si(st) : null, l), h("div", { class: "v", text: v }), h("div", { class: "s", text: s || "" }));
  const errRate = kp.toolN ? kp.toolErr / kp.toolN : 0;
  put($("#perf-kpis"),
    h("div", { class: "kgroup" }, h("h3", { text: "Usage" }), h("div", { class: "kpis" },
  tile("API calls", k(kp.calls), `${kp.sessions} agent${kp.sessions === 1 ? "" : "s"} active`),
  tile("Cost, API-equivalent", money(kp.cost), "what this would cost on the API"),
  tile("Output tokens", k(kp.out), "written by the models"),
  tile("Input processed", k(kp.inp + kp.cw + kp.cr), `${pctf(kp.cacheHit)} served from cache`),
    )),
    h("div", { class: "kgroup" }, h("h3", { text: "Quality and output" }), h("div", { class: "kpis" },
  tile("Tool calls", k(kp.toolN), `${k(kp.toolErr)} failed`),
  tile("Tool error rate", pctf(errRate), errRate > 0.1 ? "high: check the error records" : "errors ÷ tool calls", errRate > 0.1 ? "stopped" : null),
  tile("Response time", kp.latP50 ? dur(kp.latP50) : "–", kp.latP95 ? `p95 ${dur(kp.latP95)}, approximate` : "no calls"),
  tile("Shipped", `${kp.commits} commit${kp.commits === 1 ? "" : "s"}`, `${kp.prs} PR${kp.prs === 1 ? "" : "s"} · +${k(kp.add)} / −${k(kp.del)} lines`),
    )),
  );
  const span = (b) => `${clock(b.t)} to ${clock(b.t + p.step)}`;
  colChart($("#pc-req"), p.buckets, (b) => b.calls, { label: "API calls over time", axis: (v) => k(v), tip: (b) => [span(b), `${b.calls} API calls`, `${b.toolN} tool calls, ${b.toolErr} failed`] });
  colChart($("#pc-cost"), p.buckets, (b) => b.cost, { label: "API-equivalent cost over time", axis: (v) => money(v), tip: (b) => [span(b), money(b.cost) + " API-equivalent", `${b.calls} API calls`] });
  lineChart($("#pc-lat"), p.buckets, (b) => b.p95, { label: "p95 response time over time", axis: (v) => (v === 0 ? "0" : v < 60e3 ? Math.round(v / 1000) + "s" : (v / 60e3).toFixed(1) + "m"), tip: (b) => [span(b), b.p95 ? `p95 ${dur(b.p95)}` : "no calls", `${b.calls} API calls`] });
  colChart($("#pc-out"), p.buckets, (b) => b.out, { label: "Output tokens over time", axis: (v) => k(v), tip: (b) => [span(b), `${k(b.out)} output tokens`, `${k(b.inTot)} input processed`] });
  hbarList($("#pc-models"), p.models, (m) => m.cost || m.calls / 1e6, {
    name: (m) => m.model, fmt: (v) => (v >= 1e-3 ? money(v) : "–"),
    tip: (m) => [m.model, `${m.calls} API calls`, m.priced ? money(m.cost) + " API-equivalent" : "no price on file for this model", `${k(m.inTot)} input · ${k(m.out)} output tokens`],
  });
  hbarList($("#pc-agents"), p.agents, (a) => a.cost, {
    name: (a) => a.title, fmt: money,
    tip: (a) => [a.title, money(a.cost) + " API-equivalent", `${a.calls} API calls · ${k(a.out)} output tokens`, `${a.toolN} tool calls, ${a.toolErr} failed`, `${a.commits} commits · ${a.prs} PRs · +${a.add}/−${a.del} lines`, "Click to show only this agent"],
    click: (a) => { PERF.sid = a.id; const s = $("#perf-agent"); if (s) s.value = a.id; perfLoad(true); },
  });
  // tools table
  const tmax = Math.max(1, ...p.tools.map((t) => t.n));
  put($("#pc-tools"), h("table", { class: "tbl" },
    h("thead", {}, h("tr", {}, h("th", { text: "Tool" }), h("th", { text: "Calls" }), h("th", { class: "r", text: "Average" }), h("th", { class: "r", text: "p95" }), h("th", { class: "r", text: "Errors" }))),
    h("tbody", {}, ...(p.tools.length ? p.tools.map((t) => h("tr", {},
      h("td", { text: t.name }),
      h("td", {}, h("span", { class: "minibar" }, h("i", { style: { width: Math.max(3, 100 * t.n / tmax) + "%" } })), h("span", { class: "num", text: String(t.n) })),
      h("td", { class: "r", text: dur(t.avg) }), h("td", { class: "r", text: dur(t.p95) }),
      h("td", { class: "r" + (t.err / Math.max(1, t.n) > 0.1 ? " bad" : ""), text: t.err ? `${t.err} (${pctf(t.err / Math.max(1, t.n))})` : "0" }),
    )) : [h("tr", {}, h("td", { colspan: "5", class: "note", text: "No tool calls in this range." }))]))));
  // error records
  put($("#pc-errors"), h("table", { class: "tbl" },
    h("thead", {}, h("tr", {}, h("th", { text: "When" }), h("th", { text: "Agent" }), h("th", { text: "Tool" }), h("th", { text: "Error" }))),
    h("tbody", {}, ...(p.errors.length ? p.errors.map((e) => h("tr", { class: "click", tabindex: "0", title: e.text, onclick: () => openDrawer(e.id), onkeydown: (ev) => { if (ev.key === "Enter") openDrawer(e.id); } },
      h("td", { class: "m", text: clock(e.at) }), h("td", { class: "t", text: e.title }), h("td", { text: e.tool }), h("td", { class: "t err", text: e.text || "(no message)" }),
    )) : [h("tr", {}, h("td", { colspan: "4", class: "note", text: "No failed tool calls in this range." }))]))));
}
