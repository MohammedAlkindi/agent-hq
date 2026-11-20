"use strict";
// Alerts: what changed between two polls. A finished turn, a question, a stuck tool call, a
// commit, a PR or a new file conflict becomes a desktop notification (when the window is not
// in front), a short chime, and a celebration on the character. Off until you switch them on.

const AL = {
  notify: localStorage.getItem("hq-notify") === "1",
  sound: localStorage.getItem("hq-sound") === "1",
  prev: null, conflicts: null, ctx: null,
};

function alertsInit() {
  const bell = $("#bell"), snd = $("#sound");
  const paint = () => {
    bell.setAttribute("aria-pressed", String(AL.notify && "Notification" in window && Notification.permission === "granted"));
    bell.title = AL.notify ? "Desktop alerts are on" : "Turn on desktop alerts when an agent finishes, asks or gets stuck";
    snd.setAttribute("aria-pressed", String(AL.sound));
    snd.title = AL.sound ? "Chimes are on" : "Turn on chimes";
  };
  bell.addEventListener("click", async () => {
    if (!("Notification" in window)) { toast("This browser cannot show desktop alerts."); return; }
    if (AL.notify) { AL.notify = false; }
    else {
      const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      AL.notify = p === "granted";
      if (!AL.notify) toast("Alerts are blocked for this page. Allow notifications for 127.0.0.1 in Chrome's site settings.");
    }
    localStorage.setItem("hq-notify", AL.notify ? "1" : "0");
    paint();
    if (AL.notify) toast("Desktop alerts on: you'll hear about finished turns, questions, stuck tools and PRs.");
  });
  snd.addEventListener("click", () => {
    AL.sound = !AL.sound;
    localStorage.setItem("hq-sound", AL.sound ? "1" : "0");
    paint();
    if (AL.sound) chime("done");
  });
  paint();
}

function chime(kind) {
  if (!AL.sound) return;
  try {
    AL.ctx = AL.ctx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = AL.ctx, t0 = ctx.currentTime + 0.01;
    const notes = { done: [659, 880], ask: [880, 659, 880], warn: [220, 196], star: [1047, 1319, 1568], pr: [523, 659, 784, 1047] }[kind] || [660];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = kind === "warn" ? "triangle" : "sine";
      o.frequency.value = f;
      const t = t0 + i * 0.11;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + 0.25);
    });
  } catch {}
}

function notify(title, body, id) {
  if (!AL.notify || !("Notification" in window) || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return; // the page already shows it
  try {
    const n = new Notification(title, { body: body || "", tag: "hq-" + (id || title), silent: true });
    n.onclick = () => { window.focus(); if (id) openDrawer(id); n.close(); };
  } catch {}
}

// Confetti from the character, in the categorical hues; skipped under reduced motion.
function celebrate(id, glyph) {
  const el = agentEls.get(id);
  if (!el || !el.isConnected || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const box = h("span", { class: "confetti", "aria-hidden": "true" });
  for (let i = 0; i < 16; i++) {
    const a = (Math.PI * 2 * i) / 16 + Math.random() * 0.4, r = 38 + Math.random() * 30;
    box.append(h("i", { style: { "--dx": Math.cos(a) * r + "px", "--dy": Math.sin(a) * r - 20 + "px", "--rot": Math.round(Math.random() * 540) + "deg", background: `var(--s${(i % 8) + 1})` } }));
  }
  if (glyph) box.append(h("b", { text: glyph }));
  el.append(box);
  setTimeout(() => box.remove(), 1500);
}
function pop(id, text) {
  const el = agentEls.get(id);
  if (!el || !el.isConnected) return;
  const p = h("span", { class: "popup", "aria-hidden": "true", text });
  el.append(p);
  setTimeout(() => p.remove(), 1900);
}

function alertsDiff(d) {
  const waiting = needsYou(d).filter((n) => !n.seen).length; // agents you marked seen do not count
  document.title = (waiting ? `(${waiting}) ` : "") + "Agent HQ";
  const prev = AL.prev;
  AL.prev = new Map(d.sessions.map((s) => [s.id, { look: look(s), commits: s.metrics.commits, prs: s.metrics.prs, stuck: !!s.stuck }]));
  const files = new Set(d.conflicts.map((c) => c.file));
  const oldFiles = AL.conflicts;
  AL.conflicts = files;
  if (!prev) return; // first load is the baseline, not news
  for (const s of d.sessions) {
    const p = prev.get(s.id);
    if (!p) continue;
    const L = look(s);
    if (p.look === "working" && (L === "waiting" || L === "question" || L === "finished")) {
      celebrate(s.id, L === "question" ? "?" : "✓");
      chime(L === "question" ? "ask" : "done");
      notify(L === "question" ? `${s.title} asked you something` : `${s.title} finished`, s.said, s.id);
    }
    if (s.metrics.commits > p.commits) { pop(s.id, "★ committed"); chime("star"); }
    if (s.metrics.prs > p.prs) { pop(s.id, "⬆ opened a PR"); chime("pr"); notify(`${s.title} opened a pull request`, "", s.id); }
    if (s.stuck && !p.stuck) { chime("warn"); notify(`${s.title} may be stuck`, `${s.stuck.tool} has been running ${ago(s.stuck.ms)}`, s.id); }
  }
  if (oldFiles) for (const f of files) if (!oldFiles.has(f)) {
    const c = d.conflicts.find((x) => x.file === f);
    chime("warn");
    notify(`Two agents are editing ${f.split("/").pop()}`, c ? c.who.map((w) => w.title).join(" and ") : "");
  }
}
