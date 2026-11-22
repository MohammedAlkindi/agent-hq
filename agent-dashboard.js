#!/usr/bin/env node
// agent-dashboard.js - one local window onto every Claude session on this machine.
//
//   node agent-dashboard.js           serve http://127.0.0.1:7787 (exits after 20 min unwatched,
//                                     unless a prompt-box message still waits for its agent)
//   node agent-dashboard.js --open    start the server if needed, open it as a Chrome app window
//   node agent-dashboard.js --json    print one snapshot and exit
//
// PAGES:
//   /         Agent HQ (agents-ui/world.html): each session is a cartoon character in a room per
//             repo, reporting to you; helpers (subagents) stand beside their parent; scheduled jobs
//             work the night shift; closed sessions sit on the bench. Mission control holds the
//             fleet metrics (after the SigNoz Claude Agent SDK dashboard). The prompt box at the
//             bottom starts and messages background agents; see "roster + control" below.
//             Characters hold a prop for the tool they run (terminal, magnifier, globe, page,
//             megaphone, checklist), wear a model tag, sweat and show an hourglass when a tool
//             call has run 8+ min, and celebrate when a turn ends. Hover for a peek card.
//   /#perf    Performance (agents-ui/perf.js, data from /api/perf?range=1h|6h|24h&sid=): the
//             SigNoz Claude Agent SDK panels from transcripts, plus API-equivalent cost at list
//             prices, approximate response time, and commits / PRs / lines like Claude Code's
//             OpenTelemetry metrics.
//   /#timeline  one swimlane per agent: a bar per turn, failed tool calls, commits, PRs.
//   alerts.js   optional desktop notifications and chimes on finish, question, stuck, PR.
//   tray.js     "Needs you" bottom sheet: questions, stuck tools, finished turns, with Reply,
//               Details and Seen (seen is per turn and leaves the counts until new activity).
//   hq-menu.js  the "?" legend (opens once on first visit) and the ⋯ menu.
//   Updates are pushed over /api/stream (server-sent events, fs.watch on the transcripts,
//   at most one push per 600ms); the page polls only when the stream is quiet.
//   Test switches: ?nolive (poll only, lets headless screenshots finish), ?tray (open tray).
//   /details  the plain card view.
//
// SOURCES (all local, read-only):
//   ~/.claude/projects/*/<id>.jsonl   every session's transcript: title, prompts, tool calls,
//                                     turn state, model, context size. Ground truth for status.
//   ~/.claude/projects/*/<id>/subagents/*.jsonl   subagents still writing = running
//   ~/.claude/state/board/*.json      session-board.js: files each session edited, overlaps
//   ~/.claude/scheduled-tasks/        app scheduler task definitions; runs found in transcripts
//   Windows Task Scheduler            tasks whose action mentions claude/node/Github (10 min cache)
//   ~/wt                              leftover worktrees
//   claude agents --json --all        Claude Code's live roster: busy/idle, background state
// NOT AVAILABLE LOCALLY, so not shown: cloud routines, plan quota.
//
// STATUS comes from the last transcript event, not from guessing:
//   assistant ended its turn -> "Your move" (finished < 6h ago) or "Idle"
//   prompt / tool call / tool result last -> "Working" (< 10 min quiet), "Quiet" (< 2h), "Stopped"
//   scheduled-task run that ended its turn -> "Finished"
// Bound to 127.0.0.1 with a Host check, because the page shows transcript text.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const cp = require("child_process");
const crypto = require("crypto");
const adapters = require("./adapters");
const worktrees = require("./worktrees");
const coordination = require("./coordination");

const HOME = os.homedir();
const CLAUDE = path.join(HOME, ".claude");
const PROJ = path.join(CLAUDE, "projects");
const BOARD = path.join(CLAUDE, "state", "board");
const TASKS = path.join(CLAUDE, "scheduled-tasks");
const WT = path.join(HOME, "wt");
const PORT = Number(process.env.AGENT_DASH_PORT || 7787);
const URL_ = `http://127.0.0.1:${PORT}/`;

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const WINDOW = DAY;               // sessions active within this window are listed
const LIVE = 15 * MIN;            // board liveness, same as session-board.js
const FULL_READ_MAX = 40 * 1024 * 1024;
const IDLE_EXIT = 20 * MIN;

// ---------------------------------------------------------------- helpers
const normP = (p) => String(p || "").replace(/\\/g, "/");
const HOMEN = normP(HOME).toLowerCase();
function short(p) {
  const s = normP(p);
  return s.toLowerCase().startsWith(HOMEN) ? "~" + s.slice(HOMEN.length) : s;
}
function one(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
// Replies are markdown; the cards show plain text.
function plain(s) {
  return String(s || "")
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ");
}
function stripLead(s) {
  return String(s || "").trim().replace(/^(<!--[\s\S]*?-->\s*)+/, "").trim();
}

// In-Flight Secret Redaction Proxy
function sanitizeStream(text) {
  if (typeof text !== "string") return text;
  return text
    // OpenAI, Anthropic, and generic API keys (e.g. sk-...)
    .replace(/\bsk-[a-zA-Z0-9_\-]{20,}\b/g, "sk-[REDACTED]")
    // GitHub Personal Access Tokens and OAuth tokens
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{20,}\b/g, "$1_[REDACTED]")
    // Google API Keys (AIza...)
    .replace(/\bAIza[a-zA-Z0-9_\-]{20,}\b/g, "AIza[REDACTED]")
    // AWS Access Key IDs
    .replace(/\b(AKIA|ASIA|AROA)[0-9A-Z]{16}\b/g, "$1[REDACTED]")
    // Bearer authorization tokens
    .replace(/\bBearer\s+[a-zA-Z0-9_\-\.]{20,}\b/gi, "Bearer [REDACTED]")
    // Key/secret field patterns
    .replace(/(["']?(?:api[_-]?key|secret|access[_-]?token|bearer)["']?\s*[:=]\s*["'])([^"'\s]{8,})(["'])/gi, "$1[REDACTED]$3");
}

const WEBHOOK_SECRET = process.env.AGENT_DISPATCH_WEBHOOK_SECRET || "agent-hq-dispatch-secret-2026";

function generateWebhookToken(sid, decision, secret = WEBHOOK_SECRET) {
  const d = String(decision || "").trim().toLowerCase();
  return crypto.createHmac("sha256", secret).update(`${sid}:${d}`).digest("hex");
}

function verifyWebhookToken(token, sid, decision, secret = WEBHOOK_SECRET) {
  if (!token || !sid) return false;
  const t = String(token).trim().toLowerCase();
  const d = String(decision || "").trim().toLowerCase();
  const expected1 = crypto.createHmac("sha256", secret).update(`${sid}:${d}`).digest("hex").toLowerCase();
  const expected2 = crypto.createHmac("sha256", secret).update(sid).digest("hex").toLowerCase();
  try {
    const tBuf = Buffer.from(t);
    const e1Buf = Buffer.from(expected1);
    const e2Buf = Buffer.from(expected2);
    return (tBuf.length === e1Buf.length && crypto.timingSafeEqual(tBuf, e1Buf)) ||
           (tBuf.length === e2Buf.length && crypto.timingSafeEqual(tBuf, e2Buf));
  } catch {
    return false;
  }
}

// What a user-role transcript entry is. Peer messages, notices and app events are not tasks.
function classify(raw) {
  const s = stripLead(raw);
  let m = /^<scheduled-task\s+name="([^"]+)"/.exec(s);
  if (m) return { kind: "scheduled", name: m[1], text: `scheduled task: ${m[1]}` };
  if (s.startsWith("<cross-session-message")) return { kind: "peer" };
  if (s.startsWith("<command-")) {
    m = /<command-name>\/?([^<]+)<\/command-name>/.exec(s);
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s);
    return m ? { kind: "human", text: "/" + m[1].trim() + (args && args[1].trim() ? " " + args[1].trim() : "") } : { kind: "event" };
  }
  if (s.startsWith("<")) return { kind: "notice" };
  if (s.startsWith("[Request interrupted")) return { kind: "interrupt" };
  if (/^\[[^\]]{0,80}(notice|session|comment|event)[^\]]*\]/i.test(s)) return { kind: "notice" };
  return { kind: "human", text: s };
}

function toolName(n) {
  n = String(n || "");
  if (n.startsWith("mcp__")) return n.split("__").slice(-1)[0];
  return n;
}
function toolWhat(c) {
  const i = c.input || {};
  const v = i.description || i.command || (i.file_path && short(i.file_path)) || i.pattern || i.url ||
    i.query || i.skill || i.subagent_type || i.prompt || i.title || "";
  return one(v, 90);
}

// ---------------------------------------------------------------- transcripts
const S = new Map(); // transcript path -> parsed state

function fresh(file, id, project) {
  return {
    file, id, project, off: 0, partial: false, mtime: 0, size: 0,
    title: "", agent: "", first: "", prompt: "", promptAt: 0, cwd: "", branch: "", entry: "",
    model: "", ctx: 0, ids: new Set(), tool: null, text: "", textAt: 0, last: null,
    asking: 0, errors: [], sched: "", peer: 0, doneAt: 0,
    // metrics: one row per API call (message id), latest usage wins, because a message's
    // content blocks are separate transcript entries that repeat its usage
    calls: new Map(), pending: new Map(), tools: new Map(), peers: [],
    // turns [{s, e}] for the timeline; errLog of failed tool calls; outs = commits, PRs, lines
    turns: [], lastEvt: 0, errLog: [], outs: [],
    promptFull: "", askInput: null, // for the dispatcher's drafts
  };
}

const PEER_FROM = /from-name=\\?"([^"\\]+)/;
function toolStat(st, name) {
  let t = st.tools.get(name);
  if (!t) { t = { uses: [], done: [] }; st.tools.set(name, t); }
  return t;
}
// Keep only the last 24h of per-call metrics, so a long session's memory stays bounded.
function pruneMetrics(st, now) {
  const cut = now - DAY;
  for (const [id, c] of st.calls) if (c.at < cut) st.calls.delete(id);
  if (st.pending) for (const [id, p] of st.pending) if (p.at < cut) st.pending.delete(id);
  for (const t of st.tools.values()) {
    while (t.uses.length && t.uses[0] < cut) t.uses.shift();
    while (t.done.length && t.done[0][0] < cut) t.done.shift();
  }
  while (st.turns.length && st.turns[0].e && st.turns[0].e < cut) st.turns.shift();
  while (st.errLog.length && st.errLog[0].at < cut) st.errLog.shift();
  while (st.outs.length && st.outs[0].at < cut) st.outs.shift();
}

// API-equivalent prices per million tokens: [input, output, cache read] (claude-api skill table,
// cached 2026-11-03). Cache writes use the 1-hour rate, 2x input, because settings.json sets
// ENABLE_PROMPT_CACHING_1H. A model not listed gets no price instead of a guess.
const PRICES = [
  [/^(fable|mythos)-5-2/, 8, 40, 0.20], [/^(fable|mythos)-5/, 10, 50, 1.00],
  [/^opus-5-5/, 4, 20, 0.20], [/^opus-(5|4-8|4-7|4-6)\b/, 5, 25, 0.50],
  [/^sonnet-5-5/, 2, 10, 0.10], [/^sonnet-5\b/, 2, 10, 0.20], [/^sonnet-4-6/, 3, 15, 0.30],
  [/^haiku-5-5/, 0.10, 0.50, 0.01], [/^haiku-4-5/, 1, 5, 0.10],
];
function price(model) {
  const m = String(model || "").replace(/^claude-/, "");
  const r = PRICES.find(([re]) => re.test(m));
  return r ? { i: r[1], o: r[2], cr: r[3] } : null;
}
function costOf(c) {
  if (c.model && /gemini/i.test(c.model)) return adapters.geminiCostOf(c);
  if (c.model && /(gpt|codex|o1|o3)/i.test(c.model)) return adapters.codexCostOf(c);
  const p = price(c.model);
  return p ? ((c.inp || 0) * p.i + (c.cw || 0) * p.i * 2 + (c.c || 0) * p.cr + (c.o || 0) * p.o) / 1e6 : 0;
}

// What a tool call produces, after the OpenTelemetry metrics Claude Code can export:
// commits, pull requests, and lines added or removed. Counted only when the call succeeded.
const nLines = (s) => (typeof s === "string" && s.length ? s.split("\n").length : 0);
function outputOf(name, i) {
  i = i || {};
  if (name === "Bash" || name === "PowerShell") {
    const cmd = String(i.command || "");
    if (/\bgh\s+pr\s+create\b/.test(cmd)) return { k: "pr" };
    if (/\bgit\b[^\n|;&]*\scommit\b/.test(cmd) && !/--dry-run/.test(cmd)) return { k: "commit" };
    return null;
  }
  if (name === "Edit" || name === "edit_block") return { k: "loc", add: nLines(i.new_string), del: nLines(i.old_string) };
  if (name === "MultiEdit") {
    let add = 0, del = 0;
    for (const e of Array.isArray(i.edits) ? i.edits : []) { add += nLines(e && e.new_string); del += nLines(e && e.old_string); }
    return { k: "loc", add, del };
  }
  if (name === "Write" || name === "write_file") return { k: "loc", add: nLines(i.content), del: 0 };
  if (name === "NotebookEdit") return { k: "loc", add: nLines(i.new_source), del: 0 };
  return null;
}
const errText = (x) => one(typeof x.content === "string" ? x.content
  : Array.isArray(x.content) ? x.content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ") : "", 220);
function openTurn(st, at) { const t = st.turns[st.turns.length - 1]; if (!t || t.e) { st.turns.push({ s: at, e: 0 }); if (st.turns.length > 120) st.turns.shift(); } }
function closeTurn(st, at) { const t = st.turns[st.turns.length - 1]; if (t && !t.e) t.e = Math.max(at, t.s); }

function feed(st, o) {
  if (!o || typeof o !== "object") return;
  if (o.type === "custom-title") { if (o.customTitle) st.title = o.customTitle; return; }
  if (o.type === "agent-name") { if (o.agentName) st.agent = o.agentName; return; }
  if (o.type !== "user" && o.type !== "assistant") return;
  if (o.isSidechain) return;
  if (o.cwd) st.cwd = o.cwd;
  if (o.gitBranch) st.branch = o.gitBranch;
  if (o.entrypoint) st.entry = o.entrypoint;
  const at = Date.parse(o.timestamp) || st.mtime;
  const m = o.message || {};

  if (o.type === "user") {
    if (o.isMeta) return;
    const c = m.content;
    if (Array.isArray(c) && c.some((x) => x && x.type === "tool_result")) {
      const err = c.some((x) => x && x.type === "tool_result" && x.is_error);
      if (err) st.errors.push(at);
      for (const x of c) {
        if (!x || x.type !== "tool_result") continue;
        const p = st.pending.get(x.tool_use_id);
        if (!p) continue;
        st.pending.delete(x.tool_use_id);
        toolStat(st, p.name).done.push([at, Math.max(0, at - p.at), x.is_error ? 1 : 0]);
        if (x.is_error) { st.errLog.push({ at, tool: p.name, text: errText(x) }); if (st.errLog.length > 60) st.errLog.shift(); }
        else if (p.out) { st.outs.push({ at, ...p.out }); if (st.outs.length > 2000) st.outs.shift(); }
      }
      st.last = { k: "result", at, err };
      st.lastEvt = at;
      return;
    }
    const text = typeof c === "string" ? c
      : Array.isArray(c) ? c.filter((x) => x && x.type === "text").map((x) => x.text).join("\n") : "";
    const cl = classify(text);
    if (cl.kind === "scheduled") st.sched = cl.name;
    if (cl.kind === "peer") {
      st.peer++;
      const pm = PEER_FROM.exec(text);
      st.peers.push({ from: pm ? pm[1] : "another session", at });
      if (st.peers.length > 40) st.peers.splice(0, st.peers.length - 40);
    }
    if (cl.kind === "human" || cl.kind === "scheduled") {
      const t = one(cl.text, 240);
      if (!st.first) st.first = t;
      st.prompt = t;
      st.promptFull = String(cl.text).slice(0, 4000);
      st.askInput = null;
      st.promptAt = at;
      st.asking = 0;
    }
    if (cl.kind === "interrupt") { st.last = { k: "done", at }; st.doneAt = at; closeTurn(st, at); return; }
    if (cl.kind === "notice" || cl.kind === "event") return; // context only; turn state unchanged
    st.last = { k: "prompt", at };
    st.lastEvt = at;
    openTurn(st, at);
    return;
  }

  // assistant
  if (m.id) st.ids.add(m.id);
  if (m.model && !/synthetic/i.test(m.model)) st.model = m.model;
  const u = m.usage;
  if (u) {
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (ctx) st.ctx = ctx;
    if (m.id && m.model && !/synthetic/i.test(m.model)) {
      const prev = st.calls.get(m.id);
      // Latency, approximately: from the entry that sent this request (prompt or tool result)
      // to the first block of the reply landing in the transcript.
      const lat = prev ? prev.lat : (st.lastEvt && at > st.lastEvt && at - st.lastEvt < 20 * MIN ? at - st.lastEvt : 0);
      const inp = u.input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
      st.calls.set(m.id, { at: prev ? prev.at : at, model: m.model.replace(/^claude-/, ""),
        inp, cw, i: inp + cw, c: u.cache_read_input_tokens || 0, o: u.output_tokens || 0, lat });
    }
  }
  let usedTool = false;
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (!c) continue;
    if (c.type === "tool_use") {
      usedTool = true;
      const tn = toolName(c.name);
      if (c.id && !st.pending.has(c.id)) {
        st.pending.set(c.id, { name: tn, at, out: outputOf(tn, c.input) });
        toolStat(st, tn).uses.push(at);
      }
      st.tool = { name: tn, what: toolWhat(c), at };
      st.last = { k: "tool", at };
      if (c.name === "AskUserQuestion") { st.asking = at; st.askInput = c.input || null; }
    } else if (c.type === "text" && c.text && c.text.trim()) {
      st.text = c.text.trim();
      st.textAt = at;
    }
  }
  if (!usedTool && m.stop_reason && m.stop_reason !== "tool_use") {
    st.last = { k: "done", at };
    st.doneAt = at;
    closeTurn(st, at);
  }
}

function readNew(st) {
  if (st.size <= st.off) return;
  let start = st.off;
  if (start === 0 && st.size > FULL_READ_MAX) { start = st.size - FULL_READ_MAX; st.partial = true; }
  let fd;
  try {
    fd = fs.openSync(st.file, "r");
    const buf = Buffer.alloc(st.size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const lastNl = buf.subarray(0, n).lastIndexOf(10);
    if (lastNl < 0) return;
    for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
      if (!line || line.length < 20) continue;
      if (line.indexOf('"type":"user"') === -1 && line.indexOf('"type":"assistant"') === -1 &&
          line.indexOf("custom-title") === -1 && line.indexOf("agent-name") === -1) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      feed(st, o);
    }
    st.off = start + lastNl + 1;
  } catch {
    // unreadable this tick; try again next refresh
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

let listing = [];   // [{file, id, project}]
let listedAt = 0;
let relistUntil = 0; // after a start, list every poll for a minute so the newcomer appears fast
function relist(now) {
  if (now - listedAt < 20e3 && listing.length && now > relistUntil) return;
  listedAt = now;
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJ, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const d of dirs) {
    const dir = path.join(PROJ, d.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const file = path.join(dir, n);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (now - st.mtimeMs > 7 * DAY) continue;
      out.push({ file, id: n.slice(0, -6), project: d.name, mtime: st.mtimeMs });
    }
  }
  listing = out;
}

// Subagents still running, from <id>/subagents/agent-*.meta.json ("finished": true once done).
// Measured 2026-11-13: a session whose turn ended but whose background Agent is still running
// shows "busy" in ListAgents, so these count as working. The 30-min write check drops a
// subagent whose parent died before marking it finished.
// Every subagent touched in the last 2h: running ones are helpers at work, finished ones are
// shown faded beside their parent so the hierarchy stays visible after they are done.
function subagentList(st, now) {
  const dir = path.join(path.dirname(st.file), st.id, "subagents");
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const f of names) {
    if (!f.endsWith(".meta.json")) continue;
    try {
      const metaPath = path.join(dir, f);
      const log = path.join(dir, f.replace(/\.meta\.json$/, ".jsonl"));
      const m = Math.max(fs.statSync(metaPath).mtimeMs, fs.existsSync(log) ? fs.statSync(log).mtimeMs : 0);
      if (now - m > 2 * HOUR) continue;
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const running = !meta.finished && now - m < 30 * MIN;
      out.push({ what: one(meta.description || meta.agentType || "subagent", 80), type: meta.agentType || "", running, at: m });
    } catch {}
  }
  return out.sort((a, b) => (b.running - a.running) || (b.at - a.at)).slice(0, 12);
}
function subagentsRunning(st, now) { return subagentList(st, now).filter((s) => s.running); }

function titleFile(st) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(path.dirname(st.file), st.id, "custom-title.json"), "utf8"));
    return j.customTitle || "";
  } catch { return ""; }
}

// ---------------------------------------------------------------- scheduled-task history
// Runs older than the 24h window: read only the head of each 7-day transcript for its name.
const schedHead = new Map(); // file -> {name, mtime}
function schedFromHead(file, mtime) {
  const c = schedHead.get(file);
  if (c && c.mtime === mtime) return c.name;
  let name = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = /<scheduled-task name=\\?"([^"\\]+)/.exec(buf.subarray(0, n).toString("utf8"));
    if (m) name = m[1];
  } catch {}
  schedHead.set(file, { name, mtime });
  return name;
}

function appTasks(now) {
  const runs = new Map(); // name -> {last, n24, lastState}
  for (const f of listing) {
    const name = schedFromHead(f.file, f.mtime);
    if (!name) continue;
    const r = runs.get(name) || { last: 0, n24: 0 };
    if (f.mtime > r.last) r.last = f.mtime;
    if (now - f.mtime < DAY) r.n24++;
    runs.set(name, r);
  }
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(TASKS, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const d of dirs) {
    let desc = "";
    try {
      const md = fs.readFileSync(path.join(TASKS, d.name, "SKILL.md"), "utf8");
      const m = /^description:\s*(.+)$/m.exec(md);
      if (m) desc = m[1].replace(/^["']|["']$/g, "");
    } catch {}
    const r = runs.get(d.name) || { last: 0, n24: 0 };
    out.push({ name: d.name, desc: one(desc, 160), retired: /^RETIRED/i.test(desc), last: r.last, n24: r.n24 });
  }
  return out.sort((a, b) => (a.retired - b.retired) || (b.last - a.last));
}

// Windows Task Scheduler, refreshed in the background every 10 minutes.
let winTasks = { at: 0, rows: [], err: "" };
let winBusy = false;
function refreshWin(now) {
  if (winBusy || now - winTasks.at < 10 * MIN) return;
  winBusy = true;
  const ps = "$ErrorActionPreference='SilentlyContinue'; Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' } | " +
    "ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{ n=$_.TaskName; s=[string]$_.State; " +
    "last=if($i.LastRunTime){$i.LastRunTime.ToString('o')}else{''}; next=if($i.NextRunTime){$i.NextRunTime.ToString('o')}else{''}; " +
    "res=$i.LastTaskResult; a=(($_.Actions | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments }) -join ' ; ') } } | ConvertTo-Json -Compress";
  cp.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
    { windowsHide: true, timeout: 60e3, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      winBusy = false;
      winTasks.at = Date.now();
      if (err && !stdout) { winTasks.err = "could not query Task Scheduler"; return; }
      try {
        let rows = JSON.parse(stdout || "[]");
        if (!Array.isArray(rows)) rows = [rows];
        winTasks.rows = rows
          .filter((r) => /claude|antigravity|codex|node(\.exe)?\b|github|\\wt\\|agent|python/i.test(r.a || "") || /claude|agent/i.test(r.n || ""))
          .map((r) => ({ name: r.n, state: r.s, last: Date.parse(r.last) || 0, next: Date.parse(r.next) || 0,
            res: r.res, resText: resultText(r.res), action: one(r.a, 160) }));
        winTasks.err = "";
      } catch { winTasks.err = "could not read Task Scheduler output"; }
    });
}
function resultText(code) {
  const c = Number(code) >>> 0;
  if (c === 0) return "ok";
  if (c === 0x41301) return "running";
  if (c === 0x41303) return "never run";
  if (c === 0xC000013A) return "killed (0xC000013A)";
  return "0x" + c.toString(16).toUpperCase();
}

// ---------------------------------------------------------------- roster + control
// `claude agents --json --all` is Claude Code's own list of live sessions (interactive and
// background) with busy/idle and working/done/blocked. It overrides the transcript guess, and
// a session missing from it has no process: it went home.
//
// The prompt box can drive BACKGROUND agents only, because those are the ones Claude Code lets
// another program start and continue (measured 2026-11-13):
//   new agent       claude --bg -n <name> [--model m] -- <prompt>
//   follow-up       claude stop <short> (if its process is up), then claude --bg --resume <id> -- <msg>
//                   with no other flags; flags would start a copy instead
//   stop            claude stop <short>
// Desktop app sessions have no documented way in; the page copies the message for pasting.
const dispatcher = require("./dispatcher.js");

// Can a hook reach Claude desktop app sessions? Counted from desktop transcripts: each Stop
// hook run leaves a "stop_hook_summary" entry. Measured 2026-11-16: yes (18 runs in one session).
let reachCache = { at: 0, v: null };
function hookReach() {
  const now = Date.now();
  if (reachCache.v && now - reachCache.at < HOUR) return reachCache.v;
  let sessions = 0, stops = 0;
  for (const f of listing.slice().sort((a, b) => b.mtime - a.mtime).slice(0, 12)) {
    try {
      const st = fs.statSync(f.file), n = Math.min(st.size, 2 * 1024 * 1024), buf = Buffer.alloc(n);
      const fd = fs.openSync(f.file, "r"); fs.readSync(fd, buf, 0, n, st.size - n); fs.closeSync(fd);
      const t = buf.toString("utf8");
      if (!t.includes('"entrypoint":"claude-desktop"')) continue;
      sessions++;
      stops += (t.match(/"subtype":"stop_hook_summary"/g) || []).length;
    } catch {}
  }
  reachCache = { at: now, v: { desktopSessionsChecked: sessions, stopHookRuns: stops, reaches: stops > 0 } };
  return reachCache.v;
}

const CLAUDE_EXE = [path.join(HOME, ".local", "bin", "claude.exe"), path.join(HOME, ".local", "bin", "claude")]
  .find((p) => fs.existsSync(p)) || "claude";
const QUEUE_FILE = path.join(CLAUDE, "state", "agents-queue.json");

function claudeRun(args, opts = {}) {
  return new Promise((resolve) => {
    cp.execFile(CLAUDE_EXE, args, { windowsHide: true, timeout: opts.timeout || 60e3, cwd: opts.cwd || HOME, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || "") + String(stderr || ""), err: err ? err.message : "" }));
  });
}
const firstLine = (s) => one(String(s || "").split(/\r?\n/).find((l) => l.trim() && !/^Starting background/.test(l)) || "", 200);

let roster = { at: 0, ok: false, rows: new Map() };
let rosterBusy = false;
function refreshRoster(now, force) {
  if (rosterBusy || (!force && now - roster.at < 4e3)) return Promise.resolve();
  rosterBusy = true;
  return claudeRun(["agents", "--json", "--all"], { timeout: 20e3 }).then((r) => {
    rosterBusy = false;
    let rows;
    try { rows = JSON.parse(r.out.slice(r.out.indexOf("["), r.out.lastIndexOf("]") + 1)); }
    catch { roster.at = Date.now(); roster.ok = false; return; }
    const m = new Map();
    for (const x of Array.isArray(rows) ? rows : []) if (x && x.sessionId) m.set(x.sessionId, x);
    roster = { at: Date.now(), ok: true, rows: m };
  });
}
const rosterFresh = () => roster.ok && Date.now() - roster.at < 30e3;

let queue = [];   // follow-ups waiting for a busy background agent to finish its turn
let radio = [];   // recent prompt-box actions, newest first
try { queue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")).filter((q) => q && q.sid && q.text); } catch {}
function saveQueue() {
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    const tmp = QUEUE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(queue));
    fs.renameSync(tmp, QUEUE_FILE);
  } catch {}
}
function say(text, ok = true) { radio.unshift({ at: Date.now(), text, ok }); radio = radio.slice(0, 30); }

function nameFrom(text) {
  const w = String(text).replace(/@\S+/g, " ").replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return one(w || "New agent", 40).replace(/…$/, "");
}

async function startAgent(text, cwd, model, harness = "claude", options = {}) {
  const parsed = adapters.parseHarnessFromPrompt(text, harness);
  const targetHarness = parsed.harness;
  let promptText = parsed.text;

  let effectiveCwd = cwd || HOME;
  let worktreeInfo = null;

  const wantsIsolation = Boolean(options.isolate || options.worktree);
  if (wantsIsolation) {
    const isGit = await worktrees.findRepoRoot(effectiveCwd);
    if (isGit) {
      const name = nameFrom(promptText);
      const wtRes = await worktrees.createWorktree({ repo: isGit, name });
      if (wtRes.ok) {
        effectiveCwd = wtRes.path;
        worktreeInfo = wtRes;
      }
    }
  }

  if (targetHarness === "all") {
    // Fan out and distribute task across harnesses or subtask slices (separated by '|')
    const slices = promptText.includes("|")
      ? promptText.split("|").map((s) => s.trim()).filter(Boolean)
      : [promptText];
    const availableHarnesses = ["claude", "antigravity"];
    const results = [];
    for (let i = 0; i < slices.length; i++) {
      const h = availableHarnesses[i % availableHarnesses.length];
      const sliceText = slices[i];
      results.push(await startAgent(sliceText, effectiveCwd, model, h, options));
    }
    const successCount = results.filter((r) => r.ok).length;
    const msg = `Distributed ${slices.length} task slice${slices.length > 1 ? "s" : ""} across ${results.length} agents (${successCount} started).`;
    say(msg, successCount > 0);
    return { ok: successCount > 0, msg, results, worktree: worktreeInfo };
  }

  if (targetHarness === "claude") {
    const name = nameFrom(promptText);
    const args = ["--bg", "-n", name];
    if (/^(opus|sonnet|haiku|fable)$/.test(model || "")) args.push("--model", model);
    args.push("--", promptText);
    const r = await claudeRun(args, { cwd: effectiveCwd });
    const m = /backgrounded\s*·\s*([0-9a-f]{8})/.exec(r.out);
    refreshRoster(Date.now(), true);
    listedAt = 0; relistUntil = Date.now() + 60e3; // so the new agent shows up within a poll or two
    let msg = m ? `Started "${name}" in ${short(effectiveCwd)} (${m[1]})` : `Could not start Claude agent: ${firstLine(r.out) || r.err}`;
    if (worktreeInfo) msg += ` [isolated worktree: ${short(worktreeInfo.path)}]`;
    say(msg, !!m);
    return { ok: !!m, msg, worktree: worktreeInfo };
  }

  const res = await adapters.startAgent({ harness: targetHarness, text: promptText, cwd: effectiveCwd, model });
  if (worktreeInfo && res.ok) {
    res.msg += ` [isolated worktree: ${short(worktreeInfo.path)}]`;
    res.worktree = worktreeInfo;
  }
  say(res.msg, res.ok);
  return res;
}

async function deliver(sid, text) {
  const adapter = adapters.findAdapterForSession(sid);
  if (adapter && adapter.name !== "claude") {
    return await adapter.deliver(sid, text);
  }
  const r = roster.rows.get(sid);
  if (!r || r.kind !== "background") return { ok: false, msg: "That agent is not a background agent." };
  if (r.pid) await claudeRun(["stop", r.id], { timeout: 30e3 });
  const cwd = r.cwd && fs.existsSync(r.cwd) ? r.cwd : HOME;
  const res = await claudeRun(["--bg", "--resume", sid, "--", text], { cwd });
  refreshRoster(Date.now(), true);
  const ok = res.ok && /backgrounded/.test(res.out);
  return { ok, msg: ok ? `Sent to "${r.name || r.id}"` : `Could not reach "${r.name || r.id}": ${firstLine(res.out) || res.err}` };
}

// A session with no process (it went home) can be woken: `claude --bg --resume <id> -- msg`
// continues the same conversation as a background agent (measured 2026-11-14).
async function wake(sid, text) {
  const adapter = adapters.findAdapterForSession(sid);
  if (adapter && adapter.name !== "claude") {
    return await adapter.deliver(sid, text);
  }
  const st = [...S.values()].find((x) => x.id === sid);
  if (!st) return { ok: false, msg: "That session is not in the last day's transcripts." };
  if (!rosterFresh() || roster.rows.has(sid)) return { ok: false, msg: "That session is still running, so it cannot be woken." };
  const cwd = st.cwd && fs.existsSync(st.cwd) ? st.cwd : HOME;
  const res = await claudeRun(["--bg", "--resume", sid, "--", text], { cwd });
  refreshRoster(Date.now(), true);
  listedAt = 0; relistUntil = Date.now() + 60e3;
  const ok = res.ok && /backgrounded/.test(res.out);
  const msg = ok ? `Woke "${titleOfSt(st)}" as a background agent with your message` : `Could not wake "${titleOfSt(st)}": ${firstLine(res.out) || res.err}`;
  say(msg, ok);
  return { ok, msg };
}

async function message(sid, text) {
  const adapter = adapters.findAdapterForSession(sid);
  if (adapter && adapter.name !== "claude") {
    const res = await adapter.deliver(sid, text);
    say(res.msg, res.ok);
    return res;
  }
  const r = roster.rows.get(sid);
  if (!r && rosterFresh()) return wake(sid, text);
  if (!r || r.kind !== "background") return { ok: false, msg: "Desktop sessions take messages only inside the Claude app." };
  if (r.state === "working") {
    queue.push({ sid, name: r.name || r.id, text, at: Date.now() });
    saveQueue();
    const msg = `"${r.name || r.id}" is busy; your message goes in when its turn ends`;
    say(msg);
    return { ok: true, msg, queued: true };
  }
  const res = await deliver(sid, text);
  say(res.msg, res.ok);
  return res;
}

let draining = false;
async function drainQueue() {
  if (draining || !queue.length) return;
  draining = true;
  try {
    await refreshRoster(Date.now(), true);
    for (const q of [...queue]) {
      const r = roster.rows.get(q.sid);
      const stale = Date.now() - q.at > 6 * HOUR;
      if (!stale && r && r.state === "working") continue;
      queue = queue.filter((x) => x !== q);
      saveQueue();
      if (stale || !r) { say(`Dropped a waiting message for "${q.name}": ${stale ? "it waited 6 hours" : "the agent is gone"}`, false); continue; }
      const res = await deliver(q.sid, q.text);
      say(res.ok ? `Delivered your waiting message to "${q.name}"` : res.msg, res.ok);
    }
  } finally { draining = false; }
}

async function stopAgent(sid) {
  const adapter = adapters.findAdapterForSession(sid);
  if (adapter && adapter.name !== "claude") {
    const res = await adapter.stop(sid);
    say(res.msg, res.ok);
    return res;
  }
  const r = roster.rows.get(sid);
  if (!r || r.kind !== "background") return { ok: false, msg: "Only background agents can be stopped from here." };
  const res = await claudeRun(["stop", r.id], { timeout: 30e3 });
  refreshRoster(Date.now(), true);
  const msg = res.ok ? `Stopped "${r.name || r.id}" (conversation kept)` : `Could not stop "${r.name || r.id}": ${firstLine(res.out) || res.err}`;
  say(msg, res.ok);
  return { ok: res.ok, msg };
}

// Opens a terminal window attached to a background agent, where you can talk to it directly.
function attachAgent(sid) {
  const adapter = adapters.findAdapterForSession(sid);
  if (adapter && adapter.name !== "claude") {
    const res = adapter.attach(sid);
    say(res.msg, res.ok);
    return res;
  }
  const r = roster.rows.get(sid);
  if (!r || r.kind !== "background" || !/^[0-9a-f]{8}$/.test(r.id || "")) return { ok: false, msg: "Only background agents can be opened in a terminal." };
  cp.spawn("cmd.exe", ["/c", `start "${(r.name || r.id).replace(/["%^&|<>]/g, "")}" "${CLAUDE_EXE}" attach ${r.id}`],
    { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
  const msg = `Opened "${r.name || r.id}" in a terminal`;
  say(msg);
  return { ok: true, msg };
}

// ---------------------------------------------------------------- board + worktrees
function readBoard() {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(BOARD); } catch { return out; }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    try { const e = JSON.parse(fs.readFileSync(path.join(BOARD, f), "utf8")); if (e.id) out.set(e.id, e); } catch {}
  }
  return out;
}

function scanWorktreeDirs(now) {
  const out = [];
  const dirs = [path.join(HOME, "worktrees"), WT];
  for (const parent of dirs) {
    let ds = [];
    try { ds = fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")); } catch { continue; }
    for (const d of ds) {
      const p = path.join(parent, d.name);
      let m = 0;
      for (const probe of ["", "README.md", "package.json", ".git"]) {
        try { m = Math.max(m, fs.statSync(path.join(p, probe)).mtimeMs); } catch {}
      }
      const git = fs.existsSync(path.join(p, ".git"));
      out.push({ name: d.name, path: p, displayPath: short(p), age: now - m, git });
    }
  }
  return out.sort((a, b) => a.age - b.age);
}

// ---------------------------------------------------------------- snapshot
function verdict(turns) {
  if (turns <= 300) return { level: "ok", text: "keep going" };
  if (turns <= 800) return { level: "warn", text: "close soon · 1.65x rate" };
  return { level: "crit", text: "close now · 2.4x rate" };
}

function snapshot() {
  const now = Date.now();
  relist(now);
  refreshWin(now);
  refreshRoster(now);
  const board = readBoard();
  const sessions = adapters.scanAll(now, board);
  const allCalls = [];
  const allTools = new Map();
  const byId = new Map(); // id -> parsed transcript state, for the dispatcher

  const allStates = adapters.getAllStates();
  for (const st of allStates.values()) {
    pruneMetrics(st, now);
    byId.set(st.id, st);
    for (const c of st.calls.values()) allCalls.push(c);
    for (const [name, t] of st.tools) {
      const g = allTools.get(name) || { name, n: 0, err: 0, msSum: 0, msN: 0 };
      g.n += t.uses.length;
      g.err += t.done.reduce((a, d) => a + d[2], 0);
      if (t.done.length) {
        const msAvg = Math.round(t.done.reduce((a, d) => a + d[1], 0) / t.done.length);
        g.msSum += msAvg * t.uses.length;
        g.msN += t.uses.length;
      }
      allTools.set(name, g);
    }
  }

  // Overlaps among live sessions, from the board.
  const live = [...board.values()].filter((e) => {
    const s = sessions.find((x) => x.id === e.id);
    return s && now - s.lastActive <= LIVE;
  });
  const byFile = new Map();
  for (const e of live) for (const f of e.files || []) {
    if (now - f.at > 90 * MIN) continue;
    if (!byFile.has(f.p)) byFile.set(f.p, []);
    byFile.get(f.p).push({ id: e.id, at: f.at });
  }
  const titleOf = (id) => (sessions.find((s) => s.id === id) || {}).title || id.slice(0, 8);
  const conflicts = [...byFile.entries()].filter(([, v]) => v.length > 1)
    .map(([p, v]) => ({ file: short(p), who: v.sort((a, b) => b.at - a.at).map((x) => ({ title: titleOf(x.id), at: x.at })) }));
  const byRepo = new Map();
  for (const e of live) if (e.repo) {
    if (!byRepo.has(e.repo)) byRepo.set(e.repo, []);
    byRepo.get(e.repo).push(titleOf(e.id));
  }
  const repos = [...byRepo.entries()].filter(([, v]) => v.length > 1).map(([r, v]) => ({ repo: short(r), who: v }));

  // Shadow dispatcher: draft a reply for each waiting turn, and attach the current draft.
  try {
    dispatcher.consider(sessions, (id) => { const st = byId.get(id); return st ? { prompt: st.promptFull || st.prompt, reply: st.text, ask: st.asking ? st.askInput : null } : null; }, now);
    for (const s of sessions) {
      const d = dispatcher.draftFor(s);
      if (d) s.draft = d.pending ? { pending: true } : { key: d.key, label: d.label, why: d.why, reply: d.reply, action: d.action, needsHuman: d.needsHuman,
        humanReason: d.humanReason, rule: d.rule, confidence: d.confidence, wouldSend: d.wouldSend, blockedBy: d.blockedBy, rating: d.rating || "", error: d.error || "", at: d.at };
    }
  } catch {}

  const order = { working: 0, waiting: 1, quiet: 2, stopped: 3, finished: 4, idle: 5, closed: 6 };
  sessions.sort((a, b) => (order[a.state] - order[b.state]) ||
    (a.state === "waiting" ? a.since - b.since : b.lastActive - a.lastActive));

  // Fleet metrics over the last 24h, after the SigNoz Claude Agent SDK dashboard: requests over
  // time, tokens and calls by model, tool call distribution with average duration and errors.
  const BUCKET = 10 * MIN, NB = 18;
  const start = Math.floor(now / BUCKET) * BUCKET - (NB - 1) * BUCKET;
  const buckets = Array.from({ length: NB }, (_, i) => ({ t: start + i * BUCKET, n: 0, o: 0 }));
  const byModel = new Map();
  let reqs = 0, tin = 0, tout = 0, tcache = 0;
  for (const c of allCalls) {
    reqs++; tin += c.i; tout += c.o; tcache += c.c;
    const bi = Math.floor((c.at - start) / BUCKET);
    if (bi >= 0 && bi < NB) { buckets[bi].n++; buckets[bi].o += c.o; }
    const m = byModel.get(c.model) || { model: c.model, n: 0, i: 0, o: 0 };
    m.n++; m.i += c.i; m.o += c.o;
    byModel.set(c.model, m);
  }
  const toolRows = [...allTools.values()].map((g) => ({ name: g.name, n: g.n, err: g.err, ms: g.msN ? Math.round(g.msSum / g.msN) : 0 }))
    .sort((a, b) => b.n - a.n);
  const toolN = toolRows.reduce((a, t) => a + t.n, 0), toolErr = toolRows.reduce((a, t) => a + t.err, 0);

  // Folders a new agent can start in: home first, then where today's sessions worked.
  const folders = [HOME];
  for (const s of sessions) for (const p of [s.cwd]) {
    if (p && !/[\\/](Temp|scheduled-tasks)([\\/]|$)/i.test(p) &&!folders.some((f) => f.toLowerCase() === p.toLowerCase()) && folders.length < 14) {
      try { if (fs.statSync(p).isDirectory()) folders.push(p); } catch {}
    }
  }

  const tasks = appTasks(now);
  const wts = scanWorktreeDirs(now);
  const count = (s) => sessions.filter((x) => x.state === s).length;
  return {
    now,
    harnesses: ["claude", "antigravity", "codex"],
    roster: { ok: rosterFresh(), at: roster.at },
    counts: {
      working: count("working"),
      waiting: count("waiting"),
      questions: sessions.filter((x) => x.question).length,
      quiet: count("quiet") + count("stopped"),
      closed: count("closed"),
      conflicts: conflicts.length,
      schedRuns: tasks.reduce((n, t) => n + t.n24, 0),
      worktrees: wts.length,
      subagents: sessions.reduce((n, s) => n + (s.subagents || 0), 0),
      background: sessions.filter((x) => x.kind === "background" && x.state !== "closed").length,
      byHarness: {
        claude: sessions.filter((x) => x.harness === "claude").length,
        antigravity: sessions.filter((x) => x.harness === "antigravity").length,
        codex: sessions.filter((x) => x.harness === "codex").length,
      },
    },
    metrics: {
      reqs, in: tin, out: tout, cache: tcache, toolN, toolErr,
      cost: allCalls.reduce((a, c) => a + costOf(c), 0),
      commits: sessions.reduce((a, s) => a + s.metrics.commits, 0), prs: sessions.reduce((a, s) => a + s.metrics.prs, 0),
      add: sessions.reduce((a, s) => a + s.metrics.add, 0), del: sessions.reduce((a, s) => a + s.metrics.del, 0),
      stuck: sessions.filter((s) => s.stuck).length,
      buckets, bucketMin: BUCKET / MIN,
      models: [...byModel.values()].sort((a, b) => b.n - a.n),
      tools: toolRows.slice(0, 10),
    },
    sessions, conflicts, repos,
    tasks: { app: tasks, win: winTasks.rows, winAt: winTasks.at, winErr: winTasks.err },
    worktrees: wts,
    folders: folders.map((p) => ({ path: p, label: short(p) })),
    queue: queue.map((q) => ({ name: q.name, sid: q.sid, at: q.at, text: one(q.text, 120) })),
    radio: radio.slice(0, 8),
  };
}

// ---------------------------------------------------------------- performance view
// The SigNoz Claude Agent SDK dashboard's panels, computed from transcripts: KPIs, requests,
// cost, output tokens and p95 latency over time; calls and cost by model and by agent; per-tool
// count, average and p95 duration, error rate; recent error records. Optional one-agent filter.
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
const titleOfSt = (st) => st.title || st.agent || one(st.first, 70) || st.id.slice(0, 8);
function perf(range, sid) {
  const now = Date.now();
  if (!adapters.getAllStates().size) adapters.scanAll(now);
  const [span, step] = { "1h": [HOUR, 5 * MIN], "6h": [6 * HOUR, 15 * MIN], "24h": [DAY, HOUR] }[range] || [6 * HOUR, 15 * MIN];
  const n = Math.round(span / step);
  const start = Math.floor(now / step) * step - (n - 1) * step;
  const B = Array.from({ length: n }, (_, i) => ({ t: start + i * step, calls: 0, cost: 0, out: 0, inTot: 0, toolN: 0, toolErr: 0, lats: [] }));
  const bAt = (t) => B[Math.floor((t - start) / step)];
  const K = { calls: 0, cost: 0, inp: 0, cw: 0, cr: 0, out: 0, toolN: 0, toolErr: 0, commits: 0, prs: 0, add: 0, del: 0, lats: [], sessions: 0 };
  const models = new Map(), tools = new Map(), agents = [], errors = [];
  for (const st of adapters.getAllStates().values()) {
    if (sid && st.id !== sid) continue;
    if (now - st.mtime > span + HOUR) continue;
    pruneMetrics(st, now);
    const a = { id: st.id, title: titleOfSt(st), calls: 0, cost: 0, out: 0, toolN: 0, toolErr: 0, commits: 0, prs: 0, add: 0, del: 0 };
    for (const c of st.calls.values()) {
      if (c.at < start) continue;
      const cost = costOf(c);
      K.calls++; K.cost += cost; K.inp += c.inp || 0; K.cw += c.cw || 0; K.cr += c.c || 0; K.out += c.o || 0;
      if (c.lat) K.lats.push(c.lat);
      a.calls++; a.cost += cost; a.out += c.o || 0;
      const b = bAt(c.at);
      if (b) { b.calls++; b.cost += cost; b.out += c.o || 0; b.inTot += (c.inp || 0) + (c.cw || 0) + (c.c || 0); if (c.lat) b.lats.push(c.lat); }
      const md = models.get(c.model) || { model: c.model, calls: 0, cost: 0, inTot: 0, out: 0, priced: !!price(c.model) };
      md.calls++; md.cost += cost; md.inTot += (c.inp || 0) + (c.cw || 0) + (c.c || 0); md.out += c.o || 0;
      models.set(c.model, md);
    }
    for (const [name, t] of st.tools) {
      const g = tools.get(name) || { name, n: 0, err: 0, durs: [] };
      for (const u of t.uses) if (u >= start) { g.n++; a.toolN++; K.toolN++; const b = bAt(u); if (b) b.toolN++; }
      for (const d of t.done) if (d[0] >= start) {
        g.durs.push(d[1]);
        if (d[2]) { g.err++; a.toolErr++; K.toolErr++; const b = bAt(d[0]); if (b) b.toolErr++; }
      }
      if (g.n || g.durs.length) tools.set(name, g);
    }
    for (const e of st.errLog) if (e.at >= start) errors.push({ at: e.at, id: st.id, title: a.title, tool: e.tool, text: e.text });
    for (const o of st.outs) if (o.at >= start) {
      if (o.k === "commit") { a.commits++; K.commits++; } else if (o.k === "pr") { a.prs++; K.prs++; }
      else { a.add += o.add || 0; a.del += o.del || 0; K.add += o.add || 0; K.del += o.del || 0; }
    }
    if (a.calls || a.toolN) { agents.push(a); K.sessions++; }
  }
  const inAll = K.inp + K.cw + K.cr;
  return {
    range: range in { "1h": 1, "6h": 1, "24h": 1 } ? range : "6h", sid: sid || "", from: start, to: now, step,
    kpi: { calls: K.calls, cost: K.cost, inp: K.inp, cw: K.cw, cr: K.cr, out: K.out, cacheHit: inAll ? K.cr / inAll : 0,
      toolN: K.toolN, toolErr: K.toolErr, latP50: pct(K.lats, 0.5), latP95: pct(K.lats, 0.95),
      commits: K.commits, prs: K.prs, add: K.add, del: K.del, sessions: K.sessions },
    buckets: B.map((b) => ({ t: b.t, calls: b.calls, cost: b.cost, out: b.out, inTot: b.inTot, toolN: b.toolN, toolErr: b.toolErr, p95: pct(b.lats, 0.95) })),
    models: [...models.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls),
    agents: agents.sort((a, b) => b.cost - a.cost || b.calls - a.calls).slice(0, 12),
    tools: [...tools.values()].map((g) => ({ name: g.name, n: g.n, err: g.err,
      avg: g.durs.length ? Math.round(g.durs.reduce((x, y) => x + y, 0) / g.durs.length) : 0, p95: pct(g.durs, 0.95) }))
      .sort((a, b) => b.n - a.n).slice(0, 15),
    errors: errors.sort((a, b) => b.at - a.at).slice(0, 40),
  };
}

// ---------------------------------------------------------------- page
const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agents</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='%232a78d6'/></svg>">
<style>
:root{
  --page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--base:#c3c2b7;
  --accent:#2a78d6;--track:#cde2fb;--good:#0ca30c;--warn:#fab219;--serious:#ec835a;--crit:#d03b3b;--okText:#006300;
  --chip:#f0efec;--shadow:0 1px 2px rgba(0,0,0,.04);
}
:root[data-theme=dark]{
  --page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--base:#383835;
  --accent:#3987e5;--track:#0d366b;--okText:#0ca30c;--chip:#262624;--shadow:none;
}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:16px;padding:14px 28px;background:var(--page);border-bottom:1px solid var(--grid)}
h1{font-size:18px;margin:0;font-weight:600}
.upd{color:var(--muted);font-size:12px}
.sp{flex:1}
button{font:inherit;color:var(--ink2);background:var(--surface);border:1px solid var(--grid);border-radius:8px;padding:5px 10px;cursor:pointer}
button:hover{border-color:var(--base);color:var(--ink)}
main{max-width:1240px;margin:0 auto;padding:20px 28px 60px}
.tiles{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:26px}
.tile{background:var(--surface);border:1px solid var(--grid);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow);cursor:pointer;text-align:left}
.tile .lab{color:var(--ink2);font-size:12.5px;display:flex;align-items:center;gap:6px}
.tile .val{font-size:28px;font-weight:600;line-height:1.15;margin-top:4px;font-variant-numeric:tabular-nums}
.tile .sub{color:var(--muted);font-size:12px;min-height:16px}
section{margin-top:26px}
h2{font-size:13px;font-weight:600;color:var(--ink2);text-transform:none;margin:0 0 10px;display:flex;gap:8px;align-items:baseline}
h2 .n{color:var(--muted);font-weight:400}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px}
.card{background:var(--surface);border:1px solid var(--grid);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow);min-width:0}
.card.q{border-color:var(--warn)}
.row{display:flex;align-items:center;gap:8px;min-width:0}
.title{font-weight:600;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.meta{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:var(--ink2);white-space:nowrap}
.dot{width:9px;height:9px;border-radius:50%;flex:none}
.working .dot{background:var(--accent);animation:pulse 1.6s ease-in-out infinite}
.waiting .dot{background:var(--warn)} .quiet .dot{background:var(--serious)} .stopped .dot{background:var(--crit)}
.idle .dot,.closed .dot{background:transparent;border:1.5px solid var(--muted)} .finished .dot{background:var(--good)}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(42,120,214,.45)}50%{box-shadow:0 0 0 5px rgba(42,120,214,0)}}
@media (prefers-reduced-motion:reduce){.working .dot{animation:none}}
.act{margin-top:8px;font-size:13px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.act b{font-weight:600}
.said{margin-top:8px;font-size:13px;color:var(--ink2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-line}
.ask{color:var(--ink);font-weight:600;font-size:12px;margin-top:8px;display:flex;gap:6px;align-items:center}
.ask .ic{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;background:var(--warn);color:#0b0b0b;font-size:11px;font-weight:700}
.foot{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
.meter{flex:1;min-width:120px;display:flex;align-items:center;gap:8px}
.bar{flex:1;height:6px;border-radius:3px;background:var(--track);overflow:hidden}
.bar i{display:block;height:100%;border-radius:3px;background:var(--accent)}
.bar.warn i{background:var(--warn)} .bar.crit i{background:var(--crit)}
.mt{font-size:12px;color:var(--ink2);white-space:nowrap;font-variant-numeric:tabular-nums}
.chip{font-size:11.5px;color:var(--ink2);background:var(--chip);border-radius:6px;padding:2px 7px;white-space:nowrap}
.chip.err{color:var(--ink);box-shadow:inset 3px 0 0 var(--crit)}
details{margin-top:8px}
summary{cursor:pointer;color:var(--muted);font-size:12px;list-style:none}
summary::-webkit-details-marker{display:none}
summary:hover{color:var(--ink2)}
.kv{display:grid;grid-template-columns:90px 1fr;gap:3px 10px;font-size:12px;margin-top:6px}
.kv dt{color:var(--muted)} .kv dd{margin:0;color:var(--ink2);overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--grid);border-radius:12px;overflow:hidden;font-size:13px}
th{text-align:left;font-weight:600;color:var(--ink2);font-size:12px;padding:8px 12px;border-bottom:1px solid var(--grid)}
td{padding:7px 12px;border-bottom:1px solid var(--grid);vertical-align:top}
tr:last-child td{border-bottom:none}
td.m{color:var(--muted);white-space:nowrap} td.t{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alert{background:var(--surface);border:1px solid var(--grid);border-left:4px solid var(--crit);border-radius:10px;padding:10px 14px;margin-bottom:8px;font-size:13px}
.alert.repo{border-left-color:var(--serious)}
.empty{color:var(--muted);font-size:13px;padding:6px 2px}
.note{color:var(--muted);font-size:12px;margin-top:30px;line-height:1.6}
.off{position:fixed;inset:auto 16px 16px auto;background:var(--crit);color:#fff;padding:8px 12px;border-radius:8px;font-size:13px;display:none}
@media (max-width:980px){.tiles{grid-template-columns:repeat(3,minmax(0,1fr))}}
</style></head>
<body>
<header><h1>Agents</h1><span class="upd" id="upd">loading…</span><span class="sp"></span>
<button id="theme" title="Switch light or dark">Theme</button></header>
<main>
  <div class="tiles" id="tiles"></div>
  <div id="alerts"></div>
  <section id="s-waiting"></section>
  <section id="s-working"></section>
  <section id="s-quiet"></section>
  <section id="s-earlier"></section>
  <section id="s-sched"></section>
  <section id="s-wt"></section>
  <p class="note">Status comes from each session's transcript: <b>Working</b> = mid-turn and wrote in the last 10 min ·
  <b>Your move</b> = it finished its turn · <b>Quiet</b> = mid-turn but silent 10 min to 2 h (a long command, or stuck) ·
  <b>Stopped</b> = mid-turn and silent over 2 h (closed or crashed) · <b>Finished</b> = a scheduled run that completed.
  The turns bar uses your measured cost thresholds (300 / 800). Not shown, because nothing on this PC records them:
  cloud routines, plan quota. Closed sessions still show until 6 h after their last turn.</p>
</main>
<div class="off" id="off">Dashboard server stopped. Reopen it from the Desktop shortcut.</div>
<script>
const $=(s)=>document.querySelector(s);
function h(tag,attrs,...kids){const e=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs||{})){if(v==null||v===false)continue;if(k==="class")e.className=v;else if(k==="text")e.textContent=v;else if(k.startsWith("on"))e.addEventListener(k.slice(2),v);else e.setAttribute(k,v===true?"":v)}
  for(const k of kids.flat()){if(k==null||k===false)continue;e.append(k.nodeType?k:document.createTextNode(String(k)))}return e}
function ago(ms){ms=Math.max(0,ms);const s=Math.round(ms/1000);if(s<60)return s+"s";const m=Math.round(s/60);if(m<60)return m+"m";const hh=Math.floor(m/60),mm=m%60;if(hh<24)return hh+"h"+(mm&&hh<10?" "+mm+"m":"");return Math.floor(hh/24)+"d"}
function k(n){return n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e3?Math.round(n/1e3)+"k":String(n)}
function when(t,now){if(!t)return"never";return ago(now-t)+" ago"}
function until(t,now){if(!t)return"";const d=t-now;return d>0?"in "+ago(d):ago(-d)+" ago"}
const LABEL={working:"Working",waiting:"Your move",quiet:"Quiet",stopped:"Stopped",idle:"Idle",finished:"Finished",closed:"Closed"};
function pill(st){return h("span",{class:"pill "+st},h("span",{class:"dot","aria-hidden":"true"}),LABEL[st])}

function card(s,now){
  const top=h("div",{class:"row"},pill(s.state),h("span",{class:"title",title:s.title,text:s.title}),
    h("span",{class:"meta",text:(s.state==="waiting"?"waiting "+ago(now-s.since):s.state==="working"||s.state==="quiet"?"turn "+ago(now-s.since):when(s.lastActive,now))}));
  const where=[s.harness ? "["+s.harness+"]" : "", s.where+(s.branch?" @ "+s.branch:""),s.model,s.sched?"scheduled":"",s.entry&&s.entry!=="claude-desktop"?s.entry:""].filter(Boolean).join(" · ");
  const parts=[top,h("div",{class:"meta",style:"margin-top:2px",title:where,text:where})];
  if(s.activity)parts.push(h("div",{class:"act",title:s.activity.what},h("b",{text:s.activity.name}),s.activity.what?" "+s.activity.what:""," ",h("span",{class:"meta",text:"· "+ago(now-s.activity.at)})));
  if(s.question)parts.push(h("div",{class:"ask"},h("span",{class:"ic","aria-hidden":"true",text:"?"}),"It asked you something"));
  if(s.said&&(s.state==="waiting"||s.state==="finished"||s.state==="stopped"||s.state==="quiet"))parts.push(h("div",{class:"said",text:s.said}));
  const v=s.verdict,pct=Math.min(100,s.turns/800*100);
  const foot=h("div",{class:"foot"},
    h("div",{class:"meter",title:"Turns in this session; cost per turn grows with history"},
      h("div",{class:"bar "+v.level,role:"meter","aria-valuemin":"0","aria-valuemax":"800","aria-valuenow":String(s.turns),"aria-label":"turns"},h("i",{style:"width:"+pct.toFixed(1)+"%"})),
      h("span",{class:"mt",text:(s.partial?"≥":"")+s.turns+" turns · "+v.text})),
    h("span",{class:"chip",style:"font-weight:600;text-transform:capitalize",text:s.harness||"claude"}),
    s.ctx?h("span",{class:"chip",title:"Tokens in context on the last call",text:"ctx "+k(s.ctx)}):null,
    s.subagents?h("span",{class:"chip",text:s.subagents+" subagent"+(s.subagents>1?"s":"")+" running"}):null,
    s.errors10m?h("span",{class:"chip err",text:s.errors10m+" tool error"+(s.errors10m>1?"s":"")+" (10m)"}):null,
    s.files.length?h("span",{class:"chip",text:s.files.length+" file"+(s.files.length>1?"s":"")+" edited"}):null);
  parts.push(foot);
  const dl=h("dl",{class:"kv"});
  const add=(a,b)=>{if(b){dl.append(h("dt",{text:a}),h("dd",{text:b}))}};
  add("Last prompt",s.prompt);if(s.first!==s.prompt)add("First prompt",s.first);
  if(s.state==="working")add("Last said",s.said);
  add("Files",s.files.map(f=>f.p+" ("+ago(now-f.at)+")").join("\n"));
  add("Peer msgs",s.peer?String(s.peer):"");add("Session",s.id);add("Transcript",s.transcript);
  parts.push(h("details",{},h("summary",{text:"Details"}),dl));
  return h("div",{class:"card "+(s.question?"q":"")},parts);
}

function sectionCards(id,title,list,now,emptyText){
  const el=$(id);el.replaceChildren();
  if(!list.length&&!emptyText){return}
  el.append(h("h2",{},title,h("span",{class:"n",text:String(list.length)})));
  if(!list.length){el.append(h("div",{class:"empty",text:emptyText}));return}
  el.append(h("div",{class:"cards"},list.map(s=>card(s,now))));
}

function tile(label,val,sub,target,status){
  return h("button",{class:"tile",onclick:()=>{const t=$(target);if(t)t.scrollIntoView({behavior:"smooth",block:"start"})}},
    h("div",{class:"lab"},status?h("span",{class:"pill "+status},h("span",{class:"dot","aria-hidden":"true"})):null,label),
    h("div",{class:"val",text:String(val)}),h("div",{class:"sub",text:sub||""}));
}

function render(d){
  const now=d.now,c=d.counts,S=d.sessions;
  $("#upd").textContent="updated "+new Date(now).toLocaleTimeString();
  $("#tiles").replaceChildren(
    tile("Working now",c.working,c.subagents?c.subagents+" subagents running":"","#s-working","working"),
    tile("Your move",c.waiting,c.questions?c.questions+" asked you something":"finished their turn","#s-waiting","waiting"),
    tile("Quiet or stopped",c.quiet,"mid-turn, silent 10 min+","#s-quiet","quiet"),
    tile("File conflicts",c.conflicts,d.repos.length?d.repos.length+" shared repo"+(d.repos.length>1?"s":""):"none right now","#alerts"),
    tile("Scheduled runs",c.schedRuns,"last 24 h","#s-sched"),
    tile("Worktrees in ~/wt",c.worktrees,"delete once pushed","#s-wt"));
  const al=$("#alerts");al.replaceChildren();
  for(const x of d.conflicts)al.append(h("div",{class:"alert"},h("b",{text:"Same file, two sessions: "}),x.file+" — ",x.who.map(w=>w.title+" ("+ago(now-w.at)+" ago)").join(", ")));
  for(const x of d.repos)al.append(h("div",{class:"alert repo"},h("b",{text:"Shared repo: "}),x.repo+" — "+x.who.join(", ")));
  sectionCards("#s-waiting","Your move",S.filter(s=>s.state==="waiting"),now,"Nobody is waiting on you.");
  sectionCards("#s-working","Working now",S.filter(s=>s.state==="working"),now,"No session is mid-turn.");
  sectionCards("#s-quiet","Quiet or stopped mid-turn",S.filter(s=>s.state==="quiet"||s.state==="stopped"),now,"");
  // earlier today: compact table
  const er=S.filter(s=>s.state==="idle"||s.state==="finished"||s.state==="closed");const el=$("#s-earlier");el.replaceChildren();
  if(er.length){el.append(h("h2",{},"Earlier today",h("span",{class:"n",text:String(er.length)})),
    h("table",{},h("thead",{},h("tr",{},["Session","Status","Last active","Turns","Where"].map(x=>h("th",{text:x})))),
      h("tbody",{},er.map(s=>h("tr",{},h("td",{class:"t",title:s.prompt||s.title,text:s.title}),h("td",{},pill(s.state)),
        h("td",{class:"m",text:when(s.lastActive,now)}),h("td",{class:"m",text:String(s.turns)}),h("td",{class:"m t",text:s.where+(s.branch?" @ "+s.branch:"")})))))) }
  // scheduled
  const sc=$("#s-sched");sc.replaceChildren(h("h2",{},"Scheduled tasks (app)",h("span",{class:"n",text:"runs found in the last 7 days"})));
  const act=d.tasks.app.filter(t=>!t.retired&&t.last);
  if(act.length)sc.append(h("table",{},h("thead",{},h("tr",{},["Task","Last run","Runs 24 h","What it does"].map(x=>h("th",{text:x})))),
    h("tbody",{},act.map(t=>h("tr",{},h("td",{text:t.name}),h("td",{class:"m",text:when(t.last,now)}),h("td",{class:"m",text:String(t.n24)}),h("td",{class:"t",title:t.desc,text:t.desc}))))));
  else sc.append(h("div",{class:"empty",text:"No app scheduled task ran in the last 7 days."}));
  const dormant=d.tasks.app.filter(t=>!t.last||t.retired);
  if(dormant.length)sc.append(h("div",{class:"empty",text:dormant.length+" task folder(s) with no run in 7 days (most are not scheduled; the app's Scheduled list is the source of truth): "+dormant.map(t=>t.name+(t.retired?" (retired)":"")).join(", ")}));
  if(d.tasks.win.length){sc.append(h("h2",{style:"margin-top:16px"},"Windows Task Scheduler",h("span",{class:"n",text:d.tasks.winAt?"checked "+when(d.tasks.winAt,now):""})),
    h("table",{},h("thead",{},h("tr",{},["Task","State","Last run","Result","Next run"].map(x=>h("th",{text:x})))),
      h("tbody",{},d.tasks.win.map(t=>h("tr",{},h("td",{title:t.action,text:t.name}),h("td",{class:"m",text:t.state}),h("td",{class:"m",text:when(t.last,now)}),
        h("td",{},t.resText==="ok"||t.resText==="running"?h("span",{class:"meta",text:t.resText}):h("span",{class:"chip err",text:t.resText})),
        h("td",{class:"m",text:until(t.next,now)}))))))}
  else sc.append(h("div",{class:"empty",text:d.tasks.winErr||(d.tasks.winAt?"No Windows tasks run Claude, node or Github scripts.":"Checking Windows Task Scheduler…")}));
  // worktrees
  const w=$("#s-wt");w.replaceChildren(h("h2",{},"Worktrees in ~/wt",h("span",{class:"n",text:String(d.worktrees.length)})));
  if(!d.worktrees.length)w.append(h("div",{class:"empty",text:"Empty. Good."}));
  else w.append(h("table",{},h("thead",{},h("tr",{},["Folder","Last touched","Git"].map(x=>h("th",{text:x})))),
    h("tbody",{},d.worktrees.map(x=>h("tr",{},h("td",{text:x.name}),h("td",{class:"m",text:ago(x.age)+" ago"}),h("td",{class:"m",text:x.git?"yes":"no"}))))));
}

let fails=0;
async function tick(){
  try{const r=await fetch("/api/state",{cache:"no-store"});if(!r.ok)throw 0;render(await r.json());fails=0;$("#off").style.display="none"}
  catch{if(++fails>=2)$("#off").style.display="block"}
}
function applyTheme(t){document.documentElement.dataset.theme=t;localStorage.setItem("theme",t)}
applyTheme(localStorage.getItem("theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"));
$("#theme").onclick=()=>applyTheme(document.documentElement.dataset.theme==="dark"?"light":"dark");
tick();setInterval(tick,3000);
</script></body></html>`;

// ---------------------------------------------------------------- server / launcher
function ping() {
  return new Promise((res) => {
    const r = http.get(URL_ + "api/ping", { timeout: 800 }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
    r.on("timeout", () => { r.destroy(); res(false); });
  });
}

// The world page lives in agents-ui/world.html, read per request so edits show on reload.
const WORLD = path.join(__dirname, "agents-ui", "world.html");
const CSP = "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'";

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > max) { reject(new Error("too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

let broadcastLogLine = () => {};

function serve(options = {}) {
  let lastHit = Date.now();
  // Control endpoints need the per-run token from the page and a same-origin request. A custom
  // header forces a CORS preflight that this server never answers, so no other site can post.
  const TOKEN = require("crypto").randomBytes(18).toString("hex");
  const okHost = new RegExp(`^(127\\.0\\.0\\.1|localhost)(:${PORT})?$`, "i");
  const okOrigin = new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${PORT}$`, "i");
  const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

  dispatcher.start();
  const streams = new Set();
  const sessionLogPositions = new Map();

  broadcastLogLine = function(sid, rawLine) {
    if (!rawLine || !streams.size) return;
    const line = sanitizeStream(rawLine);
    const lineData = `event: log_line\ndata: ${JSON.stringify({ type: "log_line", sid, line })}\n\n`;
    const chunkData = `event: term_chunk\ndata: ${JSON.stringify({ type: "term_chunk", sid, text: line + "\n" })}\n\n`;
    for (const r of streams) {
      if (r._filterSid && r._filterSid !== sid) continue;
      try {
        r.write(lineData);
        r.write(chunkData);
      } catch {
        streams.delete(r);
      }
    }
  };

  function checkTranscriptUpdates() {
    if (!streams.size) return;
    const allStates = adapters.getAllStates();
    for (const [id, st] of allStates) {
      if (!st.file) continue;
      try {
        if (!fs.existsSync(st.file)) continue;
        const stat = fs.statSync(st.file);
        const curSize = stat.size;
        const prevSize = sessionLogPositions.get(id);
        if (prevSize === undefined) {
          sessionLogPositions.set(id, curSize);
          continue;
        }
        if (curSize > prevSize) {
          const len = curSize - prevSize;
          const fd = fs.openSync(st.file, "r");
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, prevSize);
          fs.closeSync(fd);
          sessionLogPositions.set(id, curSize);
          const chunk = buf.toString("utf8");
          const lines = chunk.split("\n").filter(Boolean);
          for (const line of lines) {
            broadcastLogLine(id, line);
          }
        } else if (curSize < prevSize) {
          sessionLogPositions.set(id, curSize);
        }
      } catch {}
    }
  }

  let pushTimer = null, lastPush = 0;
  function push() {
    lastPush = Date.now();
    if (!streams.size) return;
    checkTranscriptUpdates();
    let body;
    try { body = "event: state\ndata: " + JSON.stringify(snapshot()) + "\n\n"; } catch { return; }
    for (const r of streams) {
      if (r._filterSid) continue;
      try { r.write(body); } catch { streams.delete(r); }
    }
  }
  // At most one push per 600ms however many files change at once.
  function schedulePush(delay) {
    if (pushTimer || !streams.size) return;
    pushTimer = setTimeout(() => { pushTimer = null; push(); }, Math.max(delay, 600 - (Date.now() - lastPush), 0));
  }
  const BRAIN = path.join(HOME, ".gemini", "antigravity", "brain");
  for (const dir of [PROJ, BOARD, BRAIN]) {
    try {
      fs.watch(dir, { recursive: true }, (ev, name) => { if (name && /\.jsonl?$/.test(String(name))) schedulePush(250); });
    } catch {} // no watcher: the 4s tick below still keeps the page current
  }
  setInterval(() => schedulePush(0), 4e3).unref();
  setInterval(() => { for (const r of streams) { try { r.write(": ping\n\n"); } catch { streams.delete(r); } } }, 20e3).unref();

  const srv = http.createServer(async (req, res) => {
    if (!okHost.test(req.headers.host || "")) { res.writeHead(403); res.end(); return; }
    const u = (req.url || "/").split("?")[0];
    if (u === "/api/ping") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
    lastHit = Date.now();

    if (req.method === "POST" && u.startsWith("/api/")) {
      const isCoordination = u.startsWith("/api/leases/") || u === "/api/intent/broadcast";
      if (!isCoordination && (req.headers["x-agents-token"] !== TOKEN || (req.headers.origin && !okOrigin.test(req.headers.origin)))) {
        json(res, 403, { ok: false, msg: "Refused: reload the page." }); return;
      }
      let body;
      try { body = JSON.parse(await readBody(req, 64 * 1024) || "{}"); } catch { json(res, 400, { ok: false, msg: "Bad request." }); return; }
      try {
        await refreshRoster(Date.now(), !rosterFresh());
        const text = String(body.text || "").trim();
        if (u === "/api/prompt") {
          if (!text) { json(res, 400, { ok: false, msg: "Type something first." }); return; }
          if (body.target === "new") {
            if (/^@\S/.test(text)) { json(res, 400, { ok: false, msg: "That starts with an @name that is not an agent. Nothing was started." }); return; }
            const cwd = String(body.cwd || HOME);
            let isDir = false;
            try { isDir = fs.statSync(cwd).isDirectory(); } catch {}
            if (!isDir) { json(res, 400, { ok: false, msg: `Folder not found: ${cwd}` }); return; }
            const harness = body.harness || "claude";
            const isolate = Boolean(body.isolate || body.worktree);
            json(res, 200, await startAgent(text, cwd, body.model, harness, { isolate })); return;
          }
          if (body.target === "all") {
            const liveClaude = [...roster.rows.values()].filter((x) => x.kind === "background" && (x.pid || x.state === "working" || x.state === "blocked"));
            const allStates = adapters.getAllStates();
            const liveOther = [...allStates.values()].filter((s) => s.harness !== "claude" && s.kind === "background" && (s.state === "working" || s.state === "waiting" || s.state === "quiet"));
            const total = liveClaude.length + liveOther.length;
            if (!total) { json(res, 200, { ok: false, msg: "No background agents are currently running to broadcast to." }); return; }
            const out = [];
            for (const x of liveClaude) out.push(await message(x.sessionId, text));
            for (const x of liveOther) out.push(await message(x.id, text));
            const success = out.filter((o) => o.ok).length;
            json(res, 200, { ok: success > 0, msg: `Broadcast sent to ${success} of ${total} active background agents.` }); return;
          }
          json(res, 200, await message(String(body.target || ""), text)); return;
        }
        if (u === "/api/stop") { json(res, 200, await stopAgent(String(body.target || ""))); return; }
        if (u === "/api/attach") { json(res, 200, attachAgent(String(body.target || ""))); return; }
        if (u === "/api/dispatch/rate") { json(res, 200, dispatcher.rate(String(body.key || ""), String(body.verdict || ""), body.note)); return; }
        if (u === "/api/dispatch/redraft") { json(res, 200, dispatcher.redraft(String(body.key || ""))); return; }
        if (u === "/api/dispatch/send") {
          const key = String(body.key || "").trim();
          const draft = dispatcher.getDraft(key);
          const sid = String(body.sid || (draft && draft.id) || "").trim();
          const sendText = String(body.text || (draft && draft.reply) || "").trim();
          if (!sid) { json(res, 400, { ok: false, msg: "Session ID is required." }); return; }
          if (!sendText) { json(res, 400, { ok: false, msg: "No message text to send." }); return; }
          const resDeliver = await message(sid, sendText);
          if (resDeliver.ok && key) {
            dispatcher.markSent(key, sendText);
          }
          json(res, 200, { ok: resDeliver.ok, msg: resDeliver.msg, sid, sentText });
          return;
        }
        if (u === "/api/worktree/create") {
          const out = await worktrees.createWorktree(body);
          json(res, out.ok ? 200 : 400, out);
          return;
        }
        if (u === "/api/worktree/merge") {
          const out = await worktrees.mergeWorktree(body);
          json(res, out.ok ? 200 : 400, out);
          return;
        }
        if (u === "/api/worktree/cleanup") {
          const out = await worktrees.cleanupWorktree(body);
          json(res, out.ok ? 200 : 400, out);
          return;
        }
        if (u === "/api/leases/acquire") {
          const sessionId = String(body.sessionId || body.sid || "").trim();
          const filePath = String(body.filePath || body.path || "").trim();
          const type = String(body.type || body.lease_type || "exclusive_write").trim();
          const ttlMs = body.ttlMs || body.ttl || 60000;
          const out = coordination.acquireLease(sessionId, filePath, type, ttlMs);
          json(res, out.ok ? 200 : 409, out);
          return;
        }
        if (u === "/api/leases/release") {
          const sessionId = String(body.sessionId || body.sid || "").trim();
          const filePath = String(body.filePath || body.path || "").trim();
          const leaseId = String(body.leaseId || "").trim() || null;
          const out = coordination.releaseLease(sessionId, filePath, leaseId);
          json(res, 200, out);
          return;
        }
        if (u === "/api/intent/broadcast") {
          const sessionId = String(body.sessionId || body.sid || "").trim();
          const msg = String(body.message || body.text || "").trim();
          const files = body.files || body.affected_files || [];
          const out = coordination.broadcastIntent(sessionId, msg, files);
          json(res, out.ok ? 200 : 400, out);
          return;
        }
      } catch (e) { json(res, 500, { ok: false, msg: String(e && e.message || e) }); return; }
      finally { schedulePush(0); }
      json(res, 404, { ok: false, msg: "Unknown action." }); return;
    }

    // Live updates: one server-sent-events stream per open page; a snapshot is pushed when a
    // transcript or board file changes (debounced) and every 4s for roster and clock changes.
    // Also supports streaming log_line and term_chunk for active sessions.
    if (u === "/api/stream" || u === "/api/logs/stream") {
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      const filterSid = String(q.get("sid") || "").trim();
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write("retry: 2000\n\n");
      if (filterSid) res._filterSid = filterSid;
      streams.add(res);
      req.on("close", () => streams.delete(res));
      if (u === "/api/stream" && !filterSid) {
        try { res.write("event: state\ndata: " + JSON.stringify(snapshot()) + "\n\n"); } catch {}
      }
      if (filterSid) {
        const allStates = adapters.getAllStates();
        const st = allStates.get(filterSid) || [...allStates.values()].find((x) => x.id === filterSid);
        if (st && st.file && fs.existsSync(st.file)) {
          try {
            const lines = fs.readFileSync(st.file, "utf8").split("\n").filter(Boolean).slice(-30).map(sanitizeStream);
            for (const line of lines) {
              res.write(`event: log_line\ndata: ${JSON.stringify({ type: "log_line", sid: filterSid, line })}\n\n`);
              res.write(`event: term_chunk\ndata: ${JSON.stringify({ type: "term_chunk", sid: filterSid, text: line + "\n" })}\n\n`);
            }
          } catch {}
        }
      }
      return;
    }
    if (u === "/api/stream/broadcast" || u === "/api/logs/emit") {
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      const sid = String(q.get("sid") || "test-sid").trim();
      const text = sanitizeStream(String(q.get("text") || "Live terminal log line").trim());
      broadcastLogLine(sid, text);
      json(res, 200, { ok: true, broadcast: true, sid, text });
      return;
    }
    if (u === "/api/leases/active") {
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      const sid = q.get("sid") || q.get("sessionId") || null;
      const activeLeases = coordination.getActiveLeases(sid);
      json(res, 200, { ok: true, leases: activeLeases });
      return;
    }
    if (u === "/api/dispatch/webhook-approve") {
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      const token = String(q.get("token") || q.get("sig") || "").trim();
      const sid = String(q.get("sid") || "").trim();
      const decision = String(q.get("decision") || "approve").trim().toLowerCase();

      if (!token || !sid) {
        json(res, 400, { ok: false, error: "MISSING_PARAMETERS", msg: "token and sid query parameters are required" });
        return;
      }

      if (!verifyWebhookToken(token, sid, decision)) {
        json(res, 403, { ok: false, error: "INVALID_SIGNATURE", msg: "HMAC signature verification failed" });
        return;
      }

      if (decision === "approve" || decision === "accept") {
        const draft = dispatcher.getDraft(sid);
        let sendText = draft && draft.reply ? draft.reply : "Approved";
        let msgRes = { ok: true };
        try {
          msgRes = await message(sid, sendText);
        } catch (e) {
          msgRes = { ok: false, msg: e.message };
        }
        dispatcher.markSent(sid, sendText);
        json(res, 200, {
          ok: true,
          sid,
          decision: "approve",
          status: "approved",
          dispatched: msgRes.ok,
          text: sendText
        });
        return;
      } else if (decision === "reject" || decision === "deny") {
        dispatcher.markSent(sid, "[REJECTED]");
        json(res, 200, {
          ok: true,
          sid,
          decision: "reject",
          status: "rejected",
          msg: "Action rejected by operator"
        });
        return;
      } else {
        json(res, 400, { ok: false, error: "UNKNOWN_DECISION", msg: `Unsupported decision: ${decision}` });
        return;
      }
    }
    if (u === "/api/diff") {
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      const sid = String(q.get("sid") || "").trim();
      if (!sid) { json(res, 400, { ok: false, msg: "sid parameter is required" }); return; }
      const snap = snapshot();
      const s = snap.sessions.find((x) => x.id === sid || (x.short && x.short === sid));
      const diffResult = await worktrees.getDiffForSession(s, adapters.getAllStates());
      json(res, diffResult.ok ? 200 : 404, diffResult);
      return;
    }
    if (u === "/api/worktrees") {
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      const list = await worktrees.listWorktrees(q.get("repo") || "");
      json(res, 200, { ok: true, worktrees: list });
      return;
    }
    if (u === "/api/logs") {
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      const sid = String(q.get("sid") || "").trim();
      const tailCount = Math.min(Math.max(parseInt(q.get("tail") || "100", 10), 1), 500);
      const allStates = adapters.getAllStates();
      const st = allStates.get(sid) || [...allStates.values()].find((x) => x.id === sid);
      if (!st || !st.file || !fs.existsSync(st.file)) {
        json(res, 404, { ok: false, msg: "Session transcript not found" });
        return;
      }
      try {
        const content = fs.readFileSync(st.file, "utf8");
        const lines = content.split("\n").filter(Boolean).slice(-tailCount).map(sanitizeStream);
        json(res, 200, { ok: true, sid, totalLines: lines.length, lines });
      } catch (err) {
        json(res, 500, { ok: false, msg: err.message });
      }
      return;
    }
    if (u === "/api/dispatch") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ...dispatcher.state(Date.now()), reach: hookReach() }));
      return;
    }
    if (u === "/api/perf") {
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      let body;
      try { if (!adapters.getAllStates().size) snapshot(); body = JSON.stringify(perf(q.get("range") || "6h", q.get("sid") || "")); } catch (e) { res.writeHead(500); res.end(String(e && e.message)); return; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    // The page's scripts, from agents-ui/ by exact name only.
    const ui = /^\/ui\/([a-z0-9-]+\.js)$/.exec(u);
    if (ui) {
      let js;
      try { js = fs.readFileSync(path.join(__dirname, "agents-ui", ui[1]), "utf8"); } catch { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(js);
      return;
    }
    if (u === "/api/state") {
      let body;
      try { body = JSON.stringify(snapshot()); } catch (e) { res.writeHead(500); res.end(String(e && e.message)); return; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (u === "/" || u === "/details") {
      let html = PAGE;
      if (u === "/") {
        try { html = fs.readFileSync(WORLD, "utf8").replace("__AGENTS_TOKEN__", TOKEN); } catch { html = PAGE; }
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP });
      res.end(html);
      return;
    }
    res.writeHead(404); res.end();
  });
  srv.on("error", (e) => { console.error(e.code === "EADDRINUSE" ? `port ${PORT} is in use` : e.message); process.exit(1); });
  srv.listen(PORT, "127.0.0.1", () => {
    console.log(`agent dashboard on ${URL_}`);
    if (options && options.open) launchBrowser();
  });
  setInterval(() => { if (queue.length) drainQueue(); }, 5e3).unref();
  // Stay up while a message waits for its agent, even with the page closed.
  setInterval(() => {
    if (streams.size) lastHit = Date.now(); // an open page counts as watching
    if (Date.now() - lastHit > IDLE_EXIT && !queue.length) process.exit(0);
  }, 60e3).unref();
  return srv;
}

function launchBrowser() {
  const chrome = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
    .map((v) => process.env[v] && path.join(process.env[v], "Google", "Chrome", "Application", "chrome.exe"))
    .find((p) => p && fs.existsSync(p));
  if (chrome) cp.spawn(chrome, [`--app=${URL_}`, "--window-size=1320,920"], { detached: true, stdio: "ignore" }).unref();
  else {
    const cmd = process.platform === "win32" ? `start "" "${URL_}"` : process.platform === "darwin" ? `open "${URL_}"` : `xdg-open "${URL_}"`;
    cp.exec(cmd);
  }
}

async function open() {
  if (!(await ping())) {
    cp.spawn(process.execPath, [__filename, "--serve"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    for (let i = 0; i < 25 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 200));
  }
  launchBrowser();
}

function printHelp() {
  console.log(`Agent HQ - Visual control plane & animated office simulator for AI agents

Usage:
  npx agent-hq [options]
  node agent-dashboard.js [options]

Options:
  --open        Start background server if needed and open dashboard in Chrome/browser
  --serve       Run server in foreground without launching browser
  --no-open     Do not automatically open browser on startup
  --json        Print full system state snapshot (sessions, metrics, worktrees) and exit
  --port <p>    Specify port (default: 7787, or AGENT_DASH_PORT env var)
  -h, --help    Show this help message

Endpoints:
  /                  Visual Office Simulator (world.html)
  /#perf             Agent Fleet Performance & Cost metrics
  /details           Compact text card overview
  /api/state         Real-time JSON state snapshot
  /api/diff?sid=<id> Git diff & changed files for session
  /api/worktrees     Git worktree isolation engine status
  /api/logs?sid=<id> Live session log reader
  /api/stream        Server-Sent Events real-time event & terminal stream
  /api/logs/stream   Dedicated SSE terminal stream for active sessions
`);
}

if (require.main === module) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    printHelp();
    process.exit(0);
  } else if (process.argv.includes("--json")) {
    winTasks.at = Date.now(); // skip the slow Task Scheduler query for a one-shot print
    console.log(JSON.stringify(snapshot(), null, 2));
    process.exit(0);
  } else if (process.argv.includes("--open")) {
    open();
  } else if (process.argv.includes("--serve") || process.argv.includes("--no-open")) {
    serve({ open: false });
  } else {
    // Default invocation without arguments:
    // Starts dashboard server and opens dashboard in browser (suppressed in automated test runners)
    const shouldOpen = !process.env.AGENT_DASH_PORT && process.stdout.isTTY;
    serve({ open: shouldOpen });
  }
}

module.exports = {
  snapshot,
  classify,
  perf,
  serve,
  open,
  launchBrowser,
  printHelp,
  broadcastLogLine,
  sanitizeStream,
  generateWebhookToken,
  verifyWebhookToken,
  coordination
};
