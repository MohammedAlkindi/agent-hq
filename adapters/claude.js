"use strict";

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const {
  HOME,
  MIN,
  HOUR,
  DAY,
  short,
  one,
  plain,
  stripLead,
  nLines,
  verdict,
  pruneMetrics,
  BaseAdapter,
} = require("./base");

const CLAUDE_DIR = path.join(HOME, ".claude");
const PROJ_DIR = path.join(CLAUDE_DIR, "projects");
const FULL_READ_MAX = 40 * 1024 * 1024;
const WINDOW = DAY;

const CLAUDE_EXE = [
  path.join(HOME, ".local", "bin", "claude.exe"),
  path.join(HOME, ".local", "bin", "claude"),
].find((p) => fs.existsSync(p)) || "claude";

const QUEUE_FILE = path.join(CLAUDE_DIR, "state", "agents-queue.json");

const PRICES = [
  [/^(fable|mythos)-5-2/, 8, 40, 0.20],
  [/^(fable|mythos)-5/, 10, 50, 1.00],
  [/^opus-5-5/, 4, 20, 0.20],
  [/^opus-(5|4-8|4-7|4-6)\b/, 5, 25, 0.50],
  [/^sonnet-5-5/, 2, 10, 0.10],
  [/^sonnet-5\b/, 2, 10, 0.20],
  [/^sonnet-4-6/, 3, 15, 0.30],
  [/^haiku-5-5/, 0.10, 0.50, 0.01],
  [/^haiku-4-5/, 1, 5, 0.10],
];

function price(model) {
  const m = String(model || "").replace(/^claude-/, "");
  const r = PRICES.find(([re]) => re.test(m));
  return r ? { i: r[1], o: r[2], cr: r[3] } : null;
}

function costOf(c) {
  const p = price(c.model);
  return p
    ? ((c.inp || 0) * p.i +
        (c.cw || 0) * p.i * 2 +
        (c.c || 0) * p.cr +
        (c.o || 0) * p.o) /
        1e6
    : 0;
}

function toolName(n) {
  n = String(n || "");
  if (n.startsWith("mcp__")) return n.split("__").slice(-1)[0];
  return n;
}

function toolWhat(c) {
  const i = c.input || {};
  const v =
    i.description ||
    i.command ||
    (i.file_path && short(i.file_path)) ||
    i.pattern ||
    i.url ||
    i.query ||
    i.skill ||
    i.subagent_type ||
    i.prompt ||
    i.title ||
    "";
  return one(v, 90);
}

function outputOf(name, i) {
  i = i || {};
  if (name === "Bash" || name === "PowerShell") {
    const cmd = String(i.command || "");
    if (/\bgh\s+pr\s+create\b/.test(cmd)) return { k: "pr" };
    if (/\bgit\b[^\n|;&]*\scommit\b/.test(cmd) && !/--dry-run/.test(cmd))
      return { k: "commit" };
    return null;
  }
  if (name === "Edit" || name === "edit_block")
    return { k: "loc", add: nLines(i.new_string), del: nLines(i.old_string) };
  if (name === "MultiEdit") {
    let add = 0,
      del = 0;
    for (const e of Array.isArray(i.edits) ? i.edits : []) {
      add += nLines(e && e.new_string);
      del += nLines(e && e.old_string);
    }
    return { k: "loc", add, del };
  }
  if (name === "Write" || name === "write_file")
    return { k: "loc", add: nLines(i.content), del: 0 };
  if (name === "NotebookEdit")
    return { k: "loc", add: nLines(i.new_source), del: 0 };
  return null;
}

const errText = (x) =>
  one(
    typeof x.content === "string"
      ? x.content
      : Array.isArray(x.content)
      ? x.content
          .filter((b) => b && b.type === "text")
          .map((b) => b.text)
          .join(" ")
      : "",
    220
  );

function classify(raw) {
  const s = stripLead(raw);
  let m = /^<scheduled-task\s+name="([^"]+)"/.exec(s);
  if (m) return { kind: "scheduled", name: m[1], text: `scheduled task: ${m[1]}` };
  if (s.startsWith("<cross-session-message")) return { kind: "peer" };
  if (s.startsWith("<command-")) {
    m = /<command-name>\/?([^<]+)<\/command-name>/.exec(s);
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s);
    return m
      ? {
          kind: "human",
          text:
            "/" +
            m[1].trim() +
            (args && args[1].trim() ? " " + args[1].trim() : ""),
        }
      : { kind: "event" };
  }
  if (s.startsWith("<")) return { kind: "notice" };
  if (s.startsWith("[Request interrupted")) return { kind: "interrupt" };
  if (/^\[[^\]]{0,80}(notice|session|comment|event)[^\]]*\]/i.test(s))
    return { kind: "notice" };
  return { kind: "human", text: s };
}

function toolStat(st, name) {
  let t = st.tools.get(name);
  if (!t) {
    t = { uses: [], done: [] };
    st.tools.set(name, t);
  }
  return t;
}

function openTurn(st, at) {
  const t = st.turns[st.turns.length - 1];
  if (!t || t.e) {
    st.turns.push({ s: at, e: 0 });
    if (st.turns.length > 120) st.turns.shift();
  }
}

function closeTurn(st, at) {
  const t = st.turns[st.turns.length - 1];
  if (t && !t.e) t.e = Math.max(at, t.s);
}

function claudeRun(args, opts = {}) {
  return new Promise((resolve) => {
    cp.execFile(
      CLAUDE_EXE,
      args,
      {
        windowsHide: true,
        timeout: opts.timeout || 60e3,
        cwd: opts.cwd || HOME,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          out: String(stdout || "") + String(stderr || ""),
          err: err ? err.message : "",
        })
    );
  });
}

const firstLine = (s) =>
  one(
    String(s || "")
      .split(/\r?\n/)
      .find((l) => l.trim() && !/^Starting background/.test(l)) || "",
    200
  );

function nameFrom(text) {
  const w = String(text)
    .replace(/@\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
  return one(w || "New agent", 40).replace(/…$/, "");
}

class ClaudeAdapter extends BaseAdapter {
  constructor(options = {}) {
    super("claude", options);
    this.projectsDir = options.projectsDir || PROJ_DIR;
    this.S = new Map(); // file -> state
    this.listing = [];
    this.listedAt = 0;
    this.relistUntil = 0;
    this.roster = { at: 0, ok: false, rows: new Map() };
    this.rosterBusy = false;
    this.queue = [];
    this.radio = [];
    try {
      this.queue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")).filter(
        (q) => q && q.sid && q.text
      );
    } catch {}
  }

  say(text, ok = true) {
    this.radio.unshift({ at: Date.now(), text, ok });
    this.radio = this.radio.slice(0, 30);
  }

  saveQueue() {
    try {
      fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
      const tmp = QUEUE_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.queue));
      fs.renameSync(tmp, QUEUE_FILE);
    } catch {}
  }

  async refreshRoster(now, force) {
    if (this.rosterBusy || (!force && now - this.roster.at < 4e3)) return;
    this.rosterBusy = true;
    try {
      const r = await claudeRun(["agents", "--json", "--all"], {
        timeout: 20e3,
      });
      this.rosterBusy = false;
      let rows;
      try {
        rows = JSON.parse(r.out.slice(r.out.indexOf("["), r.out.lastIndexOf("]") + 1));
      } catch {
        this.roster.at = Date.now();
        this.roster.ok = false;
        return;
      }
      const m = new Map();
      for (const x of Array.isArray(rows) ? rows : []) {
        if (x && x.sessionId) m.set(x.sessionId, x);
      }
      this.roster = { at: Date.now(), ok: true, rows: m };
    } catch {
      this.rosterBusy = false;
    }
  }

  rosterFresh() {
    return this.roster.ok && Date.now() - this.roster.at < 30e3;
  }

  fresh(file, id, project) {
    return {
      file,
      id,
      harness: "claude",
      project,
      off: 0,
      partial: false,
      mtime: 0,
      size: 0,
      title: "",
      agent: "",
      first: "",
      prompt: "",
      promptAt: 0,
      cwd: "",
      branch: "",
      entry: "",
      model: "",
      ctx: 0,
      ids: new Set(),
      tool: null,
      text: "",
      textAt: 0,
      last: null,
      asking: 0,
      errors: [],
      sched: "",
      peer: 0,
      doneAt: 0,
      calls: new Map(),
      pending: new Map(),
      tools: new Map(),
      peers: [],
      turns: [],
      lastEvt: 0,
      errLog: [],
      outs: [],
      promptFull: "",
      askInput: null,
    };
  }

  feed(st, o) {
    if (!o || typeof o !== "object") return;
    if (o.type === "custom-title") {
      if (o.customTitle) st.title = o.customTitle;
      return;
    }
    if (o.type === "agent-name") {
      if (o.agentName) st.agent = o.agentName;
      return;
    }
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
          if (x.is_error) {
            st.errLog.push({ at, tool: p.name, text: errText(x) });
            if (st.errLog.length > 60) st.errLog.shift();
          } else if (p.out) {
            st.outs.push({ at, ...p.out });
            if (st.outs.length > 2000) st.outs.shift();
          }
        }
        st.last = { k: "result", at, err };
        st.lastEvt = at;
        return;
      }
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
          ? c
              .filter((x) => x && x.type === "text")
              .map((x) => x.text)
              .join("\n")
          : "";
      const cl = classify(text);
      if (cl.kind === "scheduled") st.sched = cl.name;
      if (cl.kind === "peer") {
        st.peer++;
        const PEER_FROM = /from-name=\\?"([^"\\]+)/;
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
      if (cl.kind === "interrupt") {
        st.last = { k: "done", at };
        st.doneAt = at;
        closeTurn(st, at);
        return;
      }
      if (cl.kind === "notice" || cl.kind === "event") return;
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
      const ctx =
        (u.input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.cache_creation_input_tokens || 0);
      if (ctx) st.ctx = ctx;
      if (m.id && m.model && !/synthetic/i.test(m.model)) {
        const prev = st.calls.get(m.id);
        const lat = prev
          ? prev.lat
          : st.lastEvt && at > st.lastEvt && at - st.lastEvt < 20 * MIN
          ? at - st.lastEvt
          : 0;
        const inp = u.input_tokens || 0,
          cw = u.cache_creation_input_tokens || 0;
        st.calls.set(m.id, {
          at: prev ? prev.at : at,
          model: m.model.replace(/^claude-/, ""),
          inp,
          cw,
          i: inp + cw,
          c: u.cache_read_input_tokens || 0,
          o: u.output_tokens || 0,
          lat,
        });
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
        if (c.name === "AskUserQuestion") {
          st.asking = at;
          st.askInput = c.input || null;
        }
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

  readNew(st) {
    if (st.size <= st.off) return;
    let start = st.off;
    if (start === 0 && st.size > FULL_READ_MAX) {
      start = st.size - FULL_READ_MAX;
      st.partial = true;
    }
    let fd;
    try {
      fd = fs.openSync(st.file, "r");
      const buf = Buffer.alloc(st.size - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      const lastNl = buf.subarray(0, n).lastIndexOf(10);
      if (lastNl < 0) return;
      for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
        if (!line || line.length < 20) continue;
        if (
          line.indexOf('"type":"user"') === -1 &&
          line.indexOf('"type":"assistant"') === -1 &&
          line.indexOf("custom-title") === -1 &&
          line.indexOf("agent-name") === -1
        )
          continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        this.feed(st, o);
      }
      st.off = start + lastNl + 1;
    } catch {
    } finally {
      if (fd !== undefined)
        try {
          fs.closeSync(fd);
        } catch {}
    }
  }

  relist(now) {
    if (
      now - this.listedAt < 20e3 &&
      this.listing.length &&
      now > this.relistUntil
    )
      return;
    this.listedAt = now;
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true }).filter((d) =>
        d.isDirectory()
      );
    } catch {}
    for (const d of dirs) {
      const dir = path.join(this.projectsDir, d.name);
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        const file = path.join(dir, n);
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        if (now - st.mtimeMs > 7 * DAY) continue;
        out.push({
          file,
          id: n.slice(0, -6),
          project: d.name,
          mtime: st.mtimeMs,
        });
      }
    }
    this.listing = out;
  }

  subagentList(st, now) {
    const dir = path.join(path.dirname(st.file), st.id, "subagents");
    const out = [];
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return out;
    }
    for (const f of names) {
      if (!f.endsWith(".meta.json")) continue;
      try {
        const metaPath = path.join(dir, f);
        const log = path.join(dir, f.replace(/\.meta\.json$/, ".jsonl"));
        const m = Math.max(
          fs.statSync(metaPath).mtimeMs,
          fs.existsSync(log) ? fs.statSync(log).mtimeMs : 0
        );
        if (now - m > 2 * HOUR) continue;
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        const running = !meta.finished && now - m < 30 * MIN;
        out.push({
          what: one(meta.description || meta.agentType || "subagent", 80),
          type: meta.agentType || "",
          running,
          at: m,
        });
      } catch {}
    }
    return out.sort((a, b) => b.running - a.running || b.at - a.at).slice(0, 12);
  }

  titleFile(st) {
    try {
      const j = JSON.parse(
        fs.readFileSync(
          path.join(path.dirname(st.file), st.id, "custom-title.json"),
          "utf8"
        )
      );
      return j.customTitle || "";
    } catch {
      return "";
    }
  }

  owns(sid) {
    return (
      [...this.S.values()].some((st) => st.id === sid) ||
      (this.rosterFresh() && this.roster.rows.has(sid))
    );
  }

  scan(now, board = new Map()) {
    this.relist(now);
    this.refreshRoster(now);

    const sessions = [];

    for (const f of this.listing) {
      if (now - f.mtime > WINDOW) continue;
      let st = this.S.get(f.file);
      if (!st) {
        st = this.fresh(f.file, f.id, f.project);
        this.S.set(f.file, st);
      }
      try {
        const s = fs.statSync(f.file);
        st.size = s.size;
        st.mtime = s.mtimeMs;
      } catch {
        continue;
      }
      this.readNew(st);
      if (!st.title) st.title = this.titleFile(st);

      const age = now - st.mtime;
      const L = st.last || {};
      let state;
      if (L.k === "done")
        state = st.sched ? "finished" : now - L.at < 6 * HOUR ? "waiting" : "idle";
      else if (L.k)
        state = age < 10 * MIN ? "working" : age < 2 * HOUR ? "quiet" : "stopped";
      else continue;

      const helpers = age < 2 * HOUR ? this.subagentList(st, now) : [];
      const subs = helpers.filter((s) => s.running);
      let background = null;
      if (
        subs.length &&
        (state === "waiting" ||
          state === "idle" ||
          state === "quiet" ||
          state === "stopped")
      ) {
        state = "working";
        background = {
          name:
            subs.length > 1
              ? `${subs.length} background agents`
              : "Background agent",
          what: subs.map((s) => s.what).join(" · "),
          at: Math.max(...subs.map((s) => s.at)),
        };
      }

      const r = this.rosterFresh() ? this.roster.rows.get(st.id) : null;
      let blocked = false;
      if (this.rosterFresh()) {
        if (!r) {
          if (state !== "finished" && !(state === "idle" && st.ids.size <= 1))
            state = state === "working" || state === "quiet" ? "stopped" : "closed";
        } else if (r.kind === "background") {
          if (r.state === "working") state = "working";
          else if (r.state === "blocked") {
            state = "waiting";
            blocked = true;
          } else if (
            state === "working" ||
            state === "quiet" ||
            state === "stopped"
          )
            state = "waiting";
        } else if (r.status === "busy") state = "working";
        else if (
          r.status === "idle" &&
          (state === "working" || state === "quiet" || state === "stopped") &&
          !subs.length
        )
          state = "waiting";
      }
      if (state === "idle" && st.ids.size <= 1) continue;

      const b = board.get(st.id);
      const turns = st.ids.size;
      const question =
        state === "waiting" && (blocked || st.asking > 0 || /\?\s*$/.test(st.text));
      const kind =
        r && r.kind === "background"
          ? "background"
          : st.sched
          ? "scheduled"
          : "desktop";

      pruneMetrics(st, now);
      let ti = 0,
        to = 0,
        tc = 0,
        cost = 0;
      for (const c of st.calls.values()) {
        ti += c.i;
        to += c.o;
        tc += c.c;
        cost += costOf(c);
      }
      let commits = 0,
        prs = 0,
        add = 0,
        del = 0;
      for (const o of st.outs) {
        if (o.k === "commit") commits++;
        else if (o.k === "pr") prs++;
        else {
          add += o.add || 0;
          del += o.del || 0;
        }
      }

      const stuck =
        state === "working" &&
        !subs.length &&
        L.k === "tool" &&
        st.tool &&
        now - Math.max(L.at, st.mtime) > 8 * MIN
          ? { tool: st.tool.name, what: st.tool.what, ms: now - L.at }
          : null;
      const closedAt = state === "working" ? 0 : st.mtime;
      const tools = [...st.tools.entries()]
        .map(([name, t]) => ({
          name,
          n: t.uses.length,
          err: t.done.reduce((a, d) => a + d[2], 0),
          ms: t.done.length
            ? Math.round(t.done.reduce((a, d) => a + d[1], 0) / t.done.length)
            : 0,
        }))
        .filter((t) => t.n)
        .sort((a, b) => b.n - a.n);

      sessions.push({
        id: st.id,
        harness: "claude",
        kind,
        short: r && r.kind === "background" ? r.id : "",
        blocked,
        waitingFor: (r && r.waitingFor) || "",
        room: short((b && b.repo) || st.cwd || ""),
        repo: b && b.repo ? short(b.repo) : "",
        cwd: st.cwd || "",
        helpers: helpers.map((x) => ({
          what: x.what,
          type: x.type,
          running: x.running,
          at: x.at,
        })),
        metrics: {
          reqs: st.calls.size,
          in: ti,
          out: to,
          cache: tc,
          tools: tools.slice(0, 10),
          cost,
          toolN: tools.reduce((a, t) => a + t.n, 0),
          toolErr: tools.reduce((a, t) => a + t.err, 0),
          commits,
          prs,
          add,
          del,
        },
        stuck,
        errLog: st.errLog.slice(-6).reverse(),
        tl: st.turns
          .filter((t) => !t.e || now - t.e < 12 * HOUR)
          .map((t) => [t.s, t.e || closedAt]),
        errAt: st.errLog
          .filter((e) => now - e.at < 12 * HOUR)
          .map((e) => e.at),
        outAt: st.outs
          .filter((o) => o.k !== "loc" && now - o.at < 12 * HOUR)
          .map((o) => [o.at, o.k]),
        peers: st.peers.filter((p) => now - p.at < 2 * HOUR).slice(-8),
        title: st.title || st.agent || one(st.first, 70) || st.id.slice(0, 8),
        where: st.cwd ? short(st.cwd) : "",
        branch: st.branch && st.branch !== "HEAD" ? st.branch : "",
        entry: st.entry,
        model: st.model.replace(/^claude-/, ""),
        state,
        question,
        since:
          state === "working" || state === "quiet"
            ? st.promptAt || L.at
            : L.at || st.mtime,
        lastActive: st.mtime,
        activity:
          background ||
          (st.tool &&
          state !== "waiting" &&
          state !== "idle" &&
          state !== "finished"
            ? { name: st.tool.name, what: st.tool.what, at: st.tool.at }
            : null),
        said: one(plain(st.text), 420),
        prompt: one(st.prompt, 300),
        first: one(st.first, 300),
        turns,
        partial: st.partial,
        verdict: verdict(turns),
        ctx: st.ctx,
        errors10m: st.errors.filter((t) => now - t < 10 * MIN).length,
        subagents: subs.length,
        sched: st.sched,
        peer: st.peer,
        files:
          b && Array.isArray(b.files)
            ? b.files.slice(0, 12).map((x) => ({ p: short(x.p), at: x.at }))
            : [],
        transcript: short(st.file),
      });

      if (st.errors.length > 200) st.errors = st.errors.slice(-50);
    }

    if (this.rosterFresh()) {
      for (const r of this.roster.rows.values()) {
        if (
          r.kind !== "background" ||
          (r.state !== "working" && r.state !== "blocked") ||
          sessions.some((s) => s.id === r.sessionId)
        )
          continue;
        const blockedOld = r.state === "blocked";
        sessions.push({
          id: r.sessionId,
          harness: "claude",
          kind: "background",
          short: r.id,
          blocked: blockedOld,
          room: short(r.cwd || ""),
          repo: "",
          cwd: r.cwd || "",
          helpers: [],
          peers: [],
          files: [],
          metrics: {
            reqs: 0,
            in: 0,
            out: 0,
            cache: 0,
            tools: [],
            toolN: 0,
            toolErr: 0,
            cost: 0,
            commits: 0,
            prs: 0,
            add: 0,
            del: 0,
          },
          stuck: null,
          errLog: [],
          tl: blockedOld ? [] : [[r.startedAt || now, 0]],
          errAt: [],
          outAt: [],
          title: r.name || r.id,
          where: short(r.cwd || ""),
          branch: "",
          entry: "",
          model: "",
          state: blockedOld ? "waiting" : "working",
          question: blockedOld,
          since: r.startedAt || now,
          lastActive: r.startedAt || now,
          activity: blockedOld
            ? null
            : { name: "Starting", what: "getting ready", at: r.startedAt || now },
          said: blockedOld
            ? "It is waiting for an answer. Open it in a terminal to reply."
            : "",
          prompt: "",
          first: "",
          turns: 0,
          partial: false,
          verdict: verdict(0),
          ctx: 0,
          errors10m: 0,
          subagents: 0,
          sched: "",
          peer: 0,
          transcript: "",
        });
      }
    }

    return sessions;
  }

  async startAgent({ text, cwd, model }) {
    const name = nameFrom(text);
    const args = ["--bg", "-n", name];
    if (/^(opus|sonnet|haiku|fable)$/.test(model || ""))
      args.push("--model", model);
    args.push("--", text);
    const r = await claudeRun(args, { cwd });
    const m = /backgrounded\s*·\s*([0-9a-f]{8})/.exec(r.out);
    await this.refreshRoster(Date.now(), true);
    this.listedAt = 0;
    this.relistUntil = Date.now() + 60e3;
    const msg = m
      ? `Started "${name}" in ${short(cwd)} (${m[1]})`
      : `Could not start Claude agent: ${firstLine(r.out) || r.err}`;
    this.say(msg, !!m);
    return { ok: !!m, msg };
  }

  async deliver(sid, text) {
    const r = this.roster.rows.get(sid);
    if (!r || r.kind !== "background")
      return { ok: false, msg: "That agent is not a background agent." };
    if (r.pid) await claudeRun(["stop", r.id], { timeout: 30e3 });
    const cwd = r.cwd && fs.existsSync(r.cwd) ? r.cwd : HOME;
    const res = await claudeRun(["--bg", "--resume", sid, "--", text], { cwd });
    await this.refreshRoster(Date.now(), true);
    const ok = res.ok && /backgrounded/.test(res.out);
    return {
      ok,
      msg: ok
        ? `Sent to "${r.name || r.id}"`
        : `Could not reach "${r.name || r.id}": ${firstLine(res.out) || res.err}`,
    };
  }

  async wake(sid, text) {
    const st = [...this.S.values()].find((x) => x.id === sid);
    if (!st)
      return { ok: false, msg: "That session is not in the last day's transcripts." };
    if (!this.rosterFresh() || this.roster.rows.has(sid))
      return {
        ok: false,
        msg: "That session is still running, so it cannot be woken.",
      };
    const cwd = st.cwd && fs.existsSync(st.cwd) ? st.cwd : HOME;
    const res = await claudeRun(["--bg", "--resume", sid, "--", text], { cwd });
    await this.refreshRoster(Date.now(), true);
    this.listedAt = 0;
    this.relistUntil = Date.now() + 60e3;
    const ok = res.ok && /backgrounded/.test(res.out);
    const msg = ok
      ? `Woke "${st.title || sid.slice(0, 8)}" as a background agent with your message`
      : `Could not wake "${st.title || sid.slice(0, 8)}": ${firstLine(res.out) || res.err}`;
    this.say(msg, ok);
    return { ok, msg };
  }

  async stop(sid) {
    const r = this.roster.rows.get(sid);
    if (!r || r.kind !== "background")
      return { ok: false, msg: "Only background agents can be stopped from here." };
    const res = await claudeRun(["stop", r.id], { timeout: 30e3 });
    await this.refreshRoster(Date.now(), true);
    const msg = res.ok
      ? `Stopped "${r.name || r.id}" (conversation kept)`
      : `Could not stop "${r.name || r.id}": ${firstLine(res.out) || res.err}`;
    this.say(msg, res.ok);
    return { ok: res.ok, msg };
  }

  attach(sid) {
    const r = this.roster.rows.get(sid);
    if (
      !r ||
      r.kind !== "background" ||
      !/^[0-9a-f]{8}$/.test(r.id || "")
    )
      return {
        ok: false,
        msg: "Only background agents can be opened in a terminal.",
      };
    cp.spawn(
      "cmd.exe",
      [
        "/c",
        `start "${(r.name || r.id).replace(/["%^&|<>]/g, "")}" "${CLAUDE_EXE}" attach ${r.id}`,
      ],
      { detached: true, stdio: "ignore", windowsVerbatimArguments: true }
    ).unref();
    const msg = `Opened "${r.name || r.id}" in a terminal`;
    this.say(msg);
    return { ok: true, msg };
  }
}

module.exports = {
  ClaudeAdapter,
  costOf,
  price,
  classify,
  nameFrom,
  toolName,
  toolWhat,
};
