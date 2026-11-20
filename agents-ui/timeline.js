"use strict";
// Timeline view: one swimlane per agent, a bar for every turn it worked, so you can see what
// happened while you were away. Red ticks are failed tool calls, stars are commits, arrows PRs.

const TL = { hours: +(localStorage.getItem("hq-tl-hours") || 6) };

function timelineRender(d) {
  const host = $("#tl");
  if (!host || !d) return;
  const now = d.now, H = TL.hours, from = now - H * 3600e3;
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Time span" });
  for (const n of [3, 6, 12]) seg.append(h("button", { type: "button", "aria-pressed": String(n === H), onclick: () => { TL.hours = n; localStorage.setItem("hq-tl-hours", String(n)); timelineRender(D); } }, `Last ${n}h`));

  const rows = d.sessions
    .filter((s) => (s.tl || []).some(([a, b]) => (b || now) >= from) || s.state === "working")
    .filter((s) => matchesFilter(s))
    .sort((a, b) => ((b.state === "working") - (a.state === "working")) || (b.lastActive - a.lastActive))
    .slice(0, 40);
  const pct = (t) => Math.max(0, Math.min(100, (100 * (t - from)) / (now - from)));
  const stepH = H <= 3 ? 0.5 : H <= 6 ? 1 : 2;
  const ticks = [];
  const first = Math.ceil(from / (stepH * 3600e3)) * stepH * 3600e3;
  for (let t = first; t <= now; t += stepH * 3600e3) if (pct(t) < 92) ticks.push(t); // keep clear of the "now" label

  const axis = h("div", { class: "tl-axis" }, h("div", { class: "tl-lab" }), h("div", { class: "tl-track" },
    ...ticks.map((t) => h("span", { class: "tk", style: { left: pct(t) + "%" }, text: clock(t) })),
    h("span", { class: "tk now", style: { left: "100%" }, text: "now" })));

  const lanes = rows.map((s) => {
    const hue = (agentEls.get(s.id) && agentEls.get(s.id).style.getPropertyValue("--hue")) || "var(--s1)";
    let busy = 0;
    const bars = (s.tl || []).map(([a, b]) => {
      const end = b || now;
      if (end < from) return null;
      busy += end - Math.max(a, from);
      const live = !b;
      const bar = h("span", { class: "tl-bar" + (live ? " live" : ""), style: { left: pct(a) + "%", width: Math.max(0.35, pct(end) - pct(a)) + "%", "--hue": hue } });
      bar.addEventListener("mousemove", (e) => showTip(e, [s.title, `${live ? "Working since" : "Worked"} ${clock(a)}${live ? "" : " to " + clock(end)}`, `${ago(end - a)}${live ? " so far" : ""}`]));
      bar.addEventListener("mouseleave", hideTip);
      return bar;
    });
    const marks = [
      ...(s.errAt || []).filter((t) => t >= from).map((t) => h("span", { class: "tl-err", style: { left: pct(t) + "%" }, title: "Failed tool call at " + clock(t) })),
      ...(s.outAt || []).filter(([t]) => t >= from).map(([t, kd]) => h("span", { class: "tl-out", style: { left: pct(t) + "%" }, title: (kd === "pr" ? "Opened a PR at " : "Committed at ") + clock(t), text: kd === "pr" ? "⬆" : "★" })),
    ];
    if (s.question && s.state === "waiting") marks.push(h("span", { class: "tl-ask", style: { left: pct(s.since) + "%" }, title: "Asked you something " + ago(now - s.since) + " ago", text: "?" }));
    const mini = botSvg(s.kind === "background" || s.kind === "scheduled" ? s.kind : "desktop", moodOf(s), false, "tl-bot");
    const lab = h("button", { class: "tl-lab", type: "button", onclick: () => openDrawer(s.id), style: { "--hue": hue } },
      mini, h("span", { class: "tl-name", text: s.title }), si(look(s)));
    return h("div", { class: "tl-row" }, lab,
      h("div", { class: "tl-track" }, ...ticks.map((t) => h("span", { class: "tl-grid", style: { left: pct(t) + "%" } })), ...bars, ...marks),
      h("span", { class: "tl-sum", title: "Time spent working in this window", text: busy ? ago(busy) : "–" }));
  });

  put(host, h("div", { class: "tl-head" }, h("h2", { text: "Who worked when" }), seg,
      h("span", { class: "note", text: "Bars are turns. ★ commit · ⬆ pull request · red tick a failed tool call · ? waiting on your answer." })),
    axis, ...(lanes.length ? lanes : [h("div", { class: "empty-note", text: "No agent worked in this window." })]));
}
