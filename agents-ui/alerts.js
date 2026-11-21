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
  const bell = $("#bell"), snd = $("#sound"), audioToggle = $("#audio-toggle");
  const paint = () => {
    if (bell) {
      bell.setAttribute("aria-pressed", String(AL.notify && "Notification" in window && Notification.permission === "granted"));
      bell.title = AL.notify ? "Desktop alerts are on" : "Turn on desktop alerts when an agent finishes, asks or gets stuck";
    }
    if (snd) {
      snd.setAttribute("aria-pressed", String(AL.sound));
      snd.title = AL.sound ? "Chimes are on" : "Turn on chimes";
    }
    if (audioToggle) {
      audioToggle.setAttribute("aria-pressed", String(AL.sound));
      audioToggle.title = AL.sound ? "Audio on (8-bit chimes enabled) · Click to mute" : "Audio muted · Click to enable 8-bit chimes";
      const ic = $("#audio-icon");
      if (ic) ic.textContent = AL.sound ? "🔊" : "🔇";
    }
  };
  if (bell) {
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
  }
  const toggleSound = () => {
    AL.sound = !AL.sound;
    localStorage.setItem("hq-sound", AL.sound ? "1" : "0");
    paint();
    if (AL.sound) {
      chime("done");
      toast("8-bit sound effects enabled 🔊");
    } else {
      toast("Audio muted 🔇");
    }
  };
  if (snd) snd.addEventListener("click", toggleSound);
  if (audioToggle) audioToggle.addEventListener("click", toggleSound);
  paint();
}

// ---------------------------------------------------------------- 8-bit audio synthesizer
// Procedural zero-dependency 8-bit synthesizer using Web Audio API:
// Square-wave fanfare for completions, two-tone pitch sweep ping for questions,
// descending sawtooth pulse for stuck/warn alerts.
function chime(kind) {
  if (!AL.sound) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    AL.ctx = AL.ctx || new AudioCtx();
    const ctx = AL.ctx;
    if (ctx.state === "suspended") ctx.resume();
    const t0 = ctx.currentTime + 0.01;

    if (kind === "done" || kind === "finish") {
      // 8-bit finish fanfare: upbeat C5-E5-G5-C6 square-wave arpeggio with triumph sustain
      const seq = [
        { f: 523.25, d: 0.08, w: "square", v: 0.15 },
        { f: 659.25, d: 0.08, w: "square", v: 0.15 },
        { f: 783.99, d: 0.08, w: "square", v: 0.16 },
        { f: 1046.50, d: 0.32, w: "square", v: 0.20 },
      ];
      let t = t0;
      seq.forEach((note) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = note.w;
        o.frequency.setValueAtTime(note.f, t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(note.v, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + note.d);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + note.d + 0.02);
        t += note.d * 0.85;
      });
      // Supporting bass tone on finish note
      const bass = ctx.createOscillator(), bg = ctx.createGain();
      bass.type = "triangle";
      bass.frequency.setValueAtTime(261.63, t0 + 0.24);
      bg.gain.setValueAtTime(0, t0 + 0.24);
      bg.gain.linearRampToValueAtTime(0.18, t0 + 0.25);
      bg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
      bass.connect(bg).connect(ctx.destination);
      bass.start(t0 + 0.24);
      bass.stop(t0 + 0.58);
    } else if (kind === "ask" || kind === "question") {
      // 8-bit question ping: two-tone rising pitch sweep
      const o1 = ctx.createOscillator(), g1 = ctx.createGain();
      o1.type = "square";
      o1.frequency.setValueAtTime(587.33, t0);
      o1.frequency.exponentialRampToValueAtTime(880.00, t0 + 0.07);
      g1.gain.setValueAtTime(0, t0);
      g1.gain.linearRampToValueAtTime(0.15, t0 + 0.01);
      g1.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.08);
      o1.connect(g1).connect(ctx.destination);
      o1.start(t0);
      o1.stop(t0 + 0.09);

      const o2 = ctx.createOscillator(), g2 = ctx.createGain();
      o2.type = "square";
      o2.frequency.setValueAtTime(880.00, t0 + 0.09);
      o2.frequency.exponentialRampToValueAtTime(1174.66, t0 + 0.22);
      g2.gain.setValueAtTime(0, t0 + 0.09);
      g2.gain.linearRampToValueAtTime(0.18, t0 + 0.10);
      g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
      o2.connect(g2).connect(ctx.destination);
      o2.start(t0 + 0.09);
      o2.stop(t0 + 0.28);
    } else if (kind === "warn" || kind === "stuck") {
      // 8-bit stuck pulse: retro descending sawtooth warning buzz
      [0, 0.14].forEach((offset) => {
        const t = t0 + offset;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sawtooth";
        o.frequency.setValueAtTime(240, t);
        o.frequency.exponentialRampToValueAtTime(110, t + 0.09);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.16, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + 0.12);
      });
    } else if (kind === "star") {
      // 8-bit commit sparkle: quick crystal arpeggio
      const notes = [783.99, 987.77, 1174.66, 1567.98];
      notes.forEach((f, i) => {
        const t = t0 + i * 0.055;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "square";
        o.frequency.setValueAtTime(f, t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.12, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + 0.16);
      });
    } else if (kind === "pr") {
      // 8-bit heroic PR fanfare: C5 -> F5 -> A5 -> C6
      const seq = [{ f: 523.25, d: 0.09 }, { f: 698.46, d: 0.09 }, { f: 880.00, d: 0.09 }, { f: 1046.50, d: 0.32 }];
      let t = t0;
      seq.forEach((note) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "square";
        o.frequency.setValueAtTime(note.f, t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.16, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + note.d);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + note.d + 0.02);
        t += note.d * 0.85;
      });
    } else {
      // Generic pleasant blip
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "square";
      o.frequency.setValueAtTime(659.25, t0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.12, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.20);
    }
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
