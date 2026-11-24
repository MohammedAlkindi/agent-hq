"use strict";
// Dispatcher views: the drafted reply on each waiting session (tray cards and the drawer), and
// the Dispatcher tab with the audit log, the shadow-mode numbers and the policy.
// Shadow mode: the dispatcher drafts and logs, it never sends. Sending a draft is your click.

const DSP = { data: null, busy: false, at: 0 };
const LABELS = { question: "Question", finished: "Finished", blocked: "Blocked", human_only: "Yours only" };

function replyTarget(s) {
  if (s.state === "closed") return { type: "wake", sid: s.id, name: s.title };
  if (s.kind === "background") return { type: "bg", sid: s.id, name: s.title };
  return { type: "desktop", sid: s.id, name: s.title };
}

async function sendDraft(s, text) {
  const t = replyTarget(s);
  if (t.type === "desktop") { await copy(text, `Copied. Paste it into "${s.title}" in the Claude app.`); return; }
  const r = await post("/api/prompt", { target: s.id, text });
  toast(r.msg || (r.ok ? "Sent." : "Could not send."));
  tick();
}

async function acceptAndSendDraft(s, d) {
  if (!d || !d.reply) return;
  const t = replyTarget(s);
  if (t.type === "desktop") {
    await copy(d.reply, `Copied. Paste it into "${s.title}" in the Claude app.`);
    if (typeof markSeen === "function") markSeen(s, true);
    if (typeof chime === "function") chime("done");
    return;
  }
  toast(`Delivering draft to ${s.title}…`);
  // One route, one answer. The server decides what happened; this function never tries a second route,
  // because a second send after an error response used to deliver the same reply twice. The idempotency
  // key lets the server ignore a repeated click or a retry of the same draft.
  const r = await post("/api/dispatch/send", { sid: s.id, key: d.key, reply: d.reply, idem: "draft:" + d.key });
  toast(r.msg || (r.ok ? "Delivered draft." : "Could not deliver draft."));
  if (r.ok) {
    if (typeof markSeen === "function") markSeen(s, true);
    tick();
    if (typeof chime === "function") chime("done");
    return;
  }
  tick();
}

async function rateDraft(key, verdict) {
  const r = await post("/api/dispatch/rate", { key, verdict });
  toast(r.msg);
  DSP.at = 0; tick();
  if (VIEW === "dispatch") dispatchLoad(true);
}

// The draft block shown under a waiting session.
function draftBox(s) {
  const d = s.draft;
  if (!d) return null;
  if (d.pending) return h("div", { class: "draft pending" }, h("span", { class: "dspin", "aria-hidden": "true" }), "Drafting a reply…");
  if (d.error) return h("div", { class: "draft err" }, `Draft failed: ${one(d.error, 120)} `,
    h("button", { class: "linkbtn", onclick: async () => { await post("/api/dispatch/redraft", { key: d.key }); tick(); } }, "Try again"));
  const t = replyTarget(s);
  const verdict = d.wouldSend
    ? h("span", { class: "dv yes", title: "In shadow mode nothing is sent. This is what it would have done." }, `Would send on its own (${d.rule}, ${Math.round(d.confidence * 100)}%)`)
    : d.action === "none" && !d.needsHuman ? h("span", { class: "dv no", text: "Nothing to send" })
    : h("span", { class: "dv no", title: (d.blockedBy || []).join("\n") }, "Would ask you: " + one((d.blockedBy || [])[0] || "", 90));
  const rate = h("span", { class: "drate" },
    h("button", { class: "linkbtn" + (d.rating === "good" ? " on" : ""), title: "This draft is what I'd send", onclick: () => rateDraft(d.key, d.rating === "good" ? "clear" : "good") }, "👍 Right"),
    h("button", { class: "linkbtn" + (d.rating === "bad" ? " on" : ""), title: "This draft or decision is wrong", onclick: () => rateDraft(d.key, d.rating === "bad" ? "clear" : "bad") }, "👎 Wrong"));
  return h("div", { class: "draft" },
    h("div", { class: "dhead2" }, h("span", { class: "dl " + (d.label || "") , text: LABELS[d.label] || d.label || "" }), h("span", { class: "dwhy", text: d.why || "" })),
    d.reply ? h("div", { class: "dreply", text: d.reply }) : h("div", { class: "dreply none", text: d.needsHuman ? `No draft: ${d.humanReason || "this one is yours"}` : "Nothing to send." }),
    h("div", { class: "dacts" },
      d.reply ? h("button", { class: "btn btn-accept", type: "button", title: "1-Click Accept & Send (Ctrl+Enter)", onclick: () => acceptAndSendDraft(s, d) }, "⚡ Accept & Send") : null,
      d.reply ? h("button", { class: "btn", type: "button", onclick: () => sendDraft(s, d.reply) }, t.type === "desktop" ? "Copy reply" : t.type === "wake" ? "Wake & send" : "Send") : null,
      d.reply ? h("button", { class: "btn", type: "button", onclick: () => { setTarget(t); ptext.value = d.reply; grow(); ptext.focus(); } }, "Edit") : null,
      verdict, rate));
}

async function dispatchLoad(force) {
  if (DSP.busy || (!force && Date.now() - DSP.at < 8e3)) return;
  DSP.busy = true;
  try {
    const r = await fetch("/api/dispatch", { cache: "no-store" });
    if (r.ok) { DSP.data = await r.json(); DSP.at = Date.now(); dispatchRender(); }
  } catch {} finally { DSP.busy = false; }
}

function dispatchRender() {
  const p = DSP.data, host = $("#dsp");
  if (!p || !host) return;
  // redraw only when something changed, so buttons stay put under the cursor
  const sig = JSON.stringify([p.counts, p.mode, p.policyError, p.offline, p.drafts.map((d) => [d.key, d.rating, d.wouldSend, d.error ? 1 : 0])]);
  if (sig === DSP.sig && host.firstChild) return;
  DSP.sig = sig;
  const c = p.counts;
  const tile = (l, v, s) => h("div", { class: "mt" }, h("div", { class: "l", text: l }), h("div", { class: "v", text: v }), h("div", { class: "s", text: s || "" }));
  const bySid = new Map((D ? D.sessions : []).map((s) => [s.id, s]));
  const rows = p.drafts.map((d) => {
    const s = bySid.get(d.id);
    return h("div", { class: "dcard" + (d.rating ? " rated" : "") },
      h("div", { class: "dc-top" },
        h("span", { class: "m", text: clock(d.at) }),
        h("button", { class: "linkbtn strong", onclick: () => s && openDrawer(d.id), title: s ? "Open details" : "Not on the board any more" }, d.title),
        h("span", { class: "dl " + (d.label || ""), text: d.error ? "Error" : (LABELS[d.label] || d.label || "") }),
        d.wouldSend ? h("span", { class: "dv yes", text: `would send (${d.rule}, ${Math.round(d.confidence * 100)}%)` })
          : h("span", { class: "dv no", text: d.error ? "failed" : d.action === "none" && !d.needsHuman ? "nothing to send" : "would ask you" }),
        h("span", { class: "m", text: d.cost ? money(d.cost) : "" })),
      d.error ? h("div", { class: "dwhy", text: d.error }) : h("div", { class: "dwhy", text: d.why || "" }),
      d.reply ? h("div", { class: "dreply", text: d.reply }) : null,
      !d.wouldSend && (d.blockedBy || []).length ? h("div", { class: "dblock", text: "Why not on its own: " + d.blockedBy.join(" · ") }) : null,
      d.error ? null : h("div", { class: "dacts" }, h("span", { class: "drate" },
        h("button", { class: "linkbtn" + (d.rating === "good" ? " on" : ""), onclick: () => rateDraft(d.key, d.rating === "good" ? "clear" : "good") }, "👍 Right"),
        h("button", { class: "linkbtn" + (d.rating === "bad" ? " on" : ""), onclick: () => rateDraft(d.key, d.rating === "bad" ? "clear" : "bad") }, "👎 Wrong"))));
  });
  const reach = p.reach || {};
  put(host,
    h("div", { class: "dsp-head" },
      h("h2", { text: "Dispatcher" }),
      h("span", { class: "mode", text: p.mode === "shadow" ? "Shadow mode: drafts and logs, never sends" : "Mode: " + p.mode }),
      p.policyError ? h("span", { class: "dv no", text: p.policyError }) : null,
      // after repeated failures the dispatcher pauses itself; say why instead of showing a list of red cards
      p.offline ? h("span", { class: "dv no", title: "It tries again on its own after the pause.", text: `Dispatcher offline: ${p.offline.reason} (until ${clock(p.offline.until)})` }) : null),
    h("p", { class: "note", text: "Every time a session stops to wait on you, the dispatcher labels why and drafts the reply you would most likely send. It also records whether your standing rules would have let it send that reply on its own. Rate drafts with 👍 or 👎: the bottom number decides whether automatic replies are ever switched on." }),
    h("div", { class: "kpis" },
      tile("Drafts today", String(c.today), c.queued ? `${c.queued} drafting now` : "one per waiting turn"),
      tile("Would send on its own", String(c.wouldSend), "covered by a standing rule"),
      tile("Needs you", String(c.needsHuman), "money, legal, credentials, facts about you"),
      tile("Cost today", money(c.cost), `${p.model}, no tools loaded`)),
    h("div", { class: "kpis", style: { marginTop: "10px" } },
      tile("Drafts rated", String(c.rated), c.rated ? `${c.good} marked right` : "rate a few to measure"),
      tile("Would-send drafts marked wrong", c.wouldSendRated ? `${c.wouldSendBad} of ${c.wouldSendRated}` : "–", "this must stay near zero before any automation"),
      tile("Hooks reach desktop sessions", reach.reaches ? "Yes" : reach.desktopSessionsChecked ? "Not seen" : "–",
        reach.reaches ? `${reach.stopHookRuns} Stop hook runs in ${reach.desktopSessionsChecked} desktop sessions` : "no desktop transcripts checked yet"),
      tile("Errors today", String(c.errors), c.errors ? "see the red cards" : "none")),
    h("h3", { class: "dsp-sub", text: "Recent drafts" }),
    ...(rows.length ? rows : [h("div", { class: "empty-note", text: "No drafts yet. They appear when a session stops to wait on you." })]),
    h("h3", { class: "dsp-sub", text: "Policy" }),
    h("div", { class: "chart" },
      h("div", { class: "note", text: `Edit ${p.policyPath}. It is re-read on every draft. Minimum confidence ${p.minConfidence}. Audit log: ${p.auditPath}` }),
      h("h4", { text: "Standing rules (his words)" }),
      ...p.rules.map((r) => h("div", { class: "prule" }, h("b", { text: r.id }), h("span", { text: `"${r.text}"` }), h("span", { class: "m", text: r.source }))),
      h("h4", { text: "Always yours" }),
      ...p.alwaysHuman.map((x) => h("div", { class: "prule" }, h("span", { text: "• " + x }))),
      h("h4", { text: "Hold list (never touched)" }),
      h("div", { class: "prule" }, h("span", { text: (p.hold || []).join(", ") || "empty" })),
      h("h4", { text: "Reaching desktop sessions later" }),
      h("div", { class: "note", text: "Stop hooks fire in desktop sessions, so automatic replies could reach them through a Stop hook that returns the reply as a reason to continue. That hook would go in settings.json, which only you change. Background agents need no hook: the dashboard can already message them." })));
}
