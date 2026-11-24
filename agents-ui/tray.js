"use strict";
// "Needs you" tray, a bottom sheet above the prompt box: who is waiting on you, why, and what
// they said, with Reply, Details and Seen. Seen is remembered per turn: when the agent posts
// something new it comes back. The counts in the header and tab title leave seen ones out.

let SEEN = {};
try { SEEN = JSON.parse(localStorage.getItem("hq-seen") || "{}"); } catch {}
let TRAY_OPEN = false;

const needKey = (s) => `${s.state}:${s.since}`;
const isSeen = (s) => SEEN[s.id] === needKey(s);

// Priority: a question or blocked agent, then a stuck tool, then the oldest finished turn,
// then a turn that stopped halfway.
function needsYou(d) {
  const out = [];
  for (const s of d.sessions) {
    let why = "", rank = 9;
    // A repeated call or failure inside the current turn (detectors.js, set by the Claude adapter). It used to be
    // "3 failed tool calls in 24 hours", which flagged three quarters of active sessions. A real question from an
    // agent still comes first: a repeat warning is a hint to look, a question is a request for you.
    const isLoop = !!(s.loop && s.loop.severity === "alarm");
    if (s.state === "waiting" && s.question) { why = s.blocked ? "Needs your answer" : "Asked you"; rank = 0; }
    else if (isLoop) { why = "Repeating itself"; rank = 0.5; }
    else if (s.stuck) { why = `Silent on ${s.stuck.tool}`; rank = 1; }
    else if (s.state === "waiting") { why = "Your move"; rank = 2; }
    else if (s.state === "stopped") { why = "Stopped mid-turn"; rank = 3; }
    else continue;
    out.push({ s, why, rank, isLoop, seen: isSeen(s) });
  }
  return out.sort((a, b) => a.rank - b.rank || a.s.since - b.s.since);
}

function markSeen(s, on) {
  if (on) SEEN[s.id] = needKey(s); else delete SEEN[s.id];
  localStorage.setItem("hq-seen", JSON.stringify(SEEN));
  if (D) render(D);
}

function trayRender(d) {
  const all = needsYou(d);
  // forget seen marks for agents that are gone
  const ids = new Set(d.sessions.map((s) => s.id));
  let pruned = false;
  for (const id of Object.keys(SEEN)) if (!ids.has(id)) { delete SEEN[id]; pruned = true; }
  if (pruned) localStorage.setItem("hq-seen", JSON.stringify(SEEN));

  const fresh = all.filter((n) => !n.seen), seen = all.filter((n) => n.seen);
  const bar = $("#traybar");
  const by = (r) => fresh.filter((n) => n.rank === r).length;
  const parts = [[by(0), "asked you"], [by(0.5), "repeating itself"], [by(1), "silent"], [by(2), "finished"], [by(3), "stopped"]].filter(([n]) => n).map(([n, t]) => `${n} ${t}`);
  bar.setAttribute("aria-expanded", String(TRAY_OPEN));
  bar.classList.toggle("clear", !fresh.length);
  put(bar,
    h("span", { class: "tray-faces", "aria-hidden": "true" }, ...fresh.slice(0, 3).map((n) => trayFace(n.s))),
    fresh.length ? h("b", { text: `${fresh.length} need${fresh.length === 1 ? "s" : ""} you` }) : h("b", {}, h("span", { class: "si finished", text: "✓" }), " All clear: nobody needs you"),
    parts.length ? h("span", { class: "tray-parts", text: parts.join(" · ") }) : null,
    seen.length ? h("span", { class: "tray-parts", text: `${seen.length} seen` }) : null,
    h("span", { class: "tray-chev", "aria-hidden": "true", text: TRAY_OPEN ? "▾" : "▴" }));

  const list = $("#traylist");
  list.hidden = !TRAY_OPEN;
  if (!TRAY_OPEN) return;
  const card = (n) => {
    const s = n.s, rank = n.rank, isLoop = n.isLoop;
    const reply = s.kind === "background" ? { type: "bg", sid: s.id, name: s.title } : { type: "desktop", sid: s.id, name: s.title };
    return h("div", { class: "tcard" + (n.seen ? " seen" : "") + (isLoop ? " loop-warning desk-loop-alert" : "") + (rank === 0 ? " q" : rank === 0.5 || rank === 1 ? " stuck" : "") },
      h("div", { class: "tc-head" }, trayFace(s), h("div", { class: "tc-t" }, h("div", { class: "tc-name", text: s.title }),
        h("div", { class: "tc-sub", text: [roomLabel(s.room || s.where || ""), modelLabel(s.model)].filter(Boolean).join(" · ") })),
        h("span", { class: "tc-why" }, si(isLoop ? "stopped" : rank === 0 ? "question" : rank === 1 ? "stopped" : rank === 3 ? "stopped" : "waiting"), `${n.why} · ${ago(d.now - (s.stuck ? d.now - s.stuck.ms : s.since))}`)),
      h("div", { class: "tc-said", text: isLoop ? `${s.loop.label}. Check whether it is making progress; this is a hint, not proof of a loop.` : s.stuck ? `${s.stuck.tool} has run ${ago(s.stuck.ms)} with no output: ${s.stuck.what || ""}` : s.said || s.prompt || "(no reply text)" }),
      s.waitingFor ? h("div", { style: { marginTop: "6px" } }, h("span", { class: "tc-wait", text: "Waiting for: " + String(s.waitingFor).replace(/_/g, " ") })) : null,
      draftBox(s),
      h("div", { class: "tc-acts" },
        isLoop ? h("button", { class: "btn btn-nudge", type: "button", title: "Ask the agent to rethink its approach", onclick: () => nudgeAgent(s) }, "💡 Nudge") : null,
        s.draft && s.draft.reply ? h("button", { class: "btn btn-accept", type: "button", title: "1-Click Accept & Send (Ctrl+Enter)", onclick: () => typeof acceptAndSendDraft === "function" && acceptAndSendDraft(s, s.draft) }, "⚡ Accept & Send") : null,
        rank !== 1 && !isLoop ? h("button", { class: "btn", type: "button", onclick: () => { setTarget(reply); TRAY_OPEN = false; render(D); $("#ptext").focus(); } }, s.kind === "background" ? "Reply" : "Reply (copies)") : null,
        h("button", { class: "btn", type: "button", onclick: () => openDrawer(s.id) }, "Details"),
        h("button", { class: "btn", type: "button", onclick: () => markSeen(s, !n.seen) }, n.seen ? "Unsee" : "Seen")));
  };
  put(list,
    ...(fresh.length ? fresh.map(card) : [h("div", { class: "empty-note", text: "Nothing new needs you. Agents you marked seen are below." })]),
    seen.length ? h("details", { class: "tc-seen" }, h("summary", { text: `Seen (${seen.length}): they come back when they post something new` }), ...seen.map(card)) : null);
}

function trayFace(s) {
  const sp = h("span", { class: "tface", style: { "--hue": (agentEls.get(s.id) && agentEls.get(s.id).style.getPropertyValue("--hue")) || "var(--s1)" } });
  sp.append(botSvg(s.kind === "background" || s.kind === "scheduled" ? s.kind : "desktop", s.question ? "ask" : s.stuck ? "worry" : "happy", false, "mini", typeof harnessOf === "function" ? harnessOf(s) : "claude"));
  return sp;
}

function trayInit() {
  if (new URLSearchParams(location.search).has("tray")) TRAY_OPEN = true; // ?tray opens it on load
  $("#traybar").addEventListener("click", () => { TRAY_OPEN = !TRAY_OPEN; if (D) trayRender(D); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && TRAY_OPEN && $("#menu").hidden) { TRAY_OPEN = false; if (D) trayRender(D); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      if (TRAY_OPEN && D) {
        const fresh = needsYou(D).filter((n) => !n.seen && n.s.draft && n.s.draft.reply);
        if (fresh.length && typeof acceptAndSendDraft === "function") {
          e.preventDefault();
          acceptAndSendDraft(fresh[0].s, fresh[0].s.draft);
        }
      }
    }
  });
}

// The nudge goes through post() so it carries the page token, and the toast reports what the server said.
// It used to call fetch() without the token (the server answered 403) and show "Nudged" regardless.
async function nudgeAgent(s) {
  const text = "Review your recent errors and reconsider the approach before retrying.";
  const r = await post("/api/dispatch/send", { sid: s.id, text, idem: `nudge:${s.id}:${s.since}` });
  if (r.ok) {
    toast(r.msg || `Nudged ${s.title}`);
    if (typeof chime === "function") chime("ask");
    return;
  }
  toast(r.msg || "Could not nudge.");
  // Nothing was sent, so offer the text in the prompt box instead.
  if (typeof setTarget === "function") setTarget({ type: s.kind === "background" ? "bg" : "desktop", sid: s.id, name: s.title });
  const pt = document.querySelector("#ptext");
  if (pt) { pt.value = text; pt.focus(); }
}

// There is no "Revert Commit" action: the button called a server route that never existed, so it could not
// work. A revert needs a design that checks the worktree first (see the landing-queue proposal), not a stub.

if (typeof window !== "undefined") {
  window.nudgeAgent = nudgeAgent;
}
