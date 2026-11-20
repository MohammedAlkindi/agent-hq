"use strict";
// The ⋯ menu (alerts, chimes, theme, plain view, shortcuts) and the "?" legend that explains
// the office. The legend opens by itself once, on the first visit.

function popToggle(btn, pop, open) {
  const on = open == null ? pop.hidden : open;
  document.querySelectorAll(".pop").forEach((p) => { if (p !== pop) p.hidden = true; });
  document.querySelectorAll("[aria-haspopup=dialog],[aria-haspopup=menu]").forEach((b) => { if (b !== btn) b.setAttribute("aria-expanded", "false"); });
  pop.hidden = !on;
  btn.setAttribute("aria-expanded", String(on));
}

function legendBuild() {
  const row = (icon, title, text) => h("div", { class: "lg-row" }, h("span", { class: "lg-ic" }, icon), h("div", {}, h("b", { text: title }), h("div", { class: "lg-t", text })));
  const mini = (kind, mood) => { const s = h("span", { class: "lg-bot", style: { "--hue": "var(--s1)" } }); s.append(botSvg(kind, mood, false, "mini")); return s; };
  const prop = (p) => h("span", { class: "lg-prop" }, (() => { const sp = h("span", {}); sp.innerHTML = `<svg viewBox="0 0 30 30" width="26" height="26">${PROP[p]}</svg>`; return sp; })());
  return [
    h("h3", { text: "What you're looking at" }),
    h("p", { class: "lg-t", text: "Each Claude session is a character. It sits in a room for the folder or repo it works in, and reports to you in the office at the top." }),
    h("h4", { text: "Who they are" }),
    row(mini("desktop", "happy"), "Headset", "A session in the Claude app."),
    row(mini("background", "happy"), "Antenna", "A background agent. The prompt box can start, message and stop these."),
    row(mini("scheduled", "happy"), "Nightcap", "A scheduled job, on the night shift."),
    row(mini("helper", "work"), "Propeller cap", "A helper (subagent) working for the character above it."),
    h("h4", { text: "What they're doing" }),
    row(prop("type"), "Page", "Writing or editing files."),
    row(prop("read"), "Magnifier", "Reading or searching."),
    row(prop("run"), "Terminal", "Running a command."),
    row(prop("web"), "Globe", "Using a browser."),
    row(prop("delegate"), "Megaphone", "Handing work to helpers."),
    row(prop("plan"), "Checklist", "Updating its plan."),
    row(prop("stuck"), "Hourglass", "A tool call has run 8+ minutes with nothing new. It may be hung."),
    h("h4", { text: "Signals" }),
    row(si("waiting"), "Your move", "It finished its turn. Mark it Seen in the tray if you don't need to act."),
    row(si("question"), "Asked you", "It asked a question or is blocked on one."),
    row(si("quiet"), "Quiet", "Mid-turn with nothing new for a while."),
    row(si("stopped"), "Stopped", "It stopped mid-turn, or is stuck."),
    row(h("span", { class: "batt" }, h("i", { style: { width: "70%" } })), "Battery", "Turns used. Yellow past 300 (close soon), red past 800 (close now)."),
    row(h("span", { class: "chipx err", text: "2 err" }), "Errors", "Failed tool calls in the last 10 minutes."),
    row(h("span", { text: "⚡" }), "Conflict", "Two agents edited the same file."),
    row(h("span", { text: "✉" }), "Mail", "Another session messaged it."),
    h("h4", { text: "Keys" }),
    h("div", { class: "lg-t" }, "Ctrl+K prompt box · Alt+1/2/3 Office, Performance, Timeline · Esc closes"),
  ];
}

function menuInit() {
  const lbtn = $("#legendbtn"), lpop = $("#legend"), mbtn = $("#morebtn"), mpop = $("#moremenu");
  put(lpop, ...legendBuild());
  lbtn.addEventListener("click", (e) => { e.stopPropagation(); popToggle(lbtn, lpop); });
  mbtn.addEventListener("click", (e) => { e.stopPropagation(); popToggle(mbtn, mpop); });
  document.addEventListener("click", (e) => {
    for (const [b, p] of [[lbtn, lpop], [mbtn, mpop]]) if (!p.hidden && !p.contains(e.target) && !b.contains(e.target)) popToggle(b, p, false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { popToggle(lbtn, lpop, false); popToggle(mbtn, mpop, false); } });
  if (!localStorage.getItem("hq-legend-seen")) { localStorage.setItem("hq-legend-seen", "1"); setTimeout(() => popToggle(lbtn, lpop, true), 600); }
}
