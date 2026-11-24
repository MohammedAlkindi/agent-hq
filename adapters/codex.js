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

const CODEX_DIR =
  process.env.CODEX_SESSIONS_DIR ||
  process.env.CODEX_TRANSCRIPTS_DIR ||
  path.join(HOME, ".codex", "sessions");

const CODEX_CLI = process.env.CODEX_CLI || "codex";
const FULL_READ_MAX = 20 * 1024 * 1024;
const WINDOW = DAY;

const CODEX_PRICES = [
  [/^gpt-4o/, 2.5, 10.0, 1.25],
  [/^gpt-4o-mini/, 0.15, 0.6, 0.075],
  [/^o1/, 15.0, 60.0, 7.5],
  [/^o3/, 10.0, 40.0, 5.0],
  [/^codex/, 2.5, 10.0, 1.25],
];

function codexPrice(model) {
  const m = String(model || "").toLowerCase();
  const r = CODEX_PRICES.find(([re]) => re.test(m));
  return r ? { i: r[1], o: r[2], cr: r[3] } : { i: 2.5, o: 10.0, cr: 1.25 };
}

function codexCostOf(c) {
  const p = codexPrice(c.model);
  return (
    ((c.inp || 0) * p.i +
      (c.cw || 0) * p.i * 2 +
      (c.c || 0) * p.cr +
      (c.o || 0) * p.o) /
    1e6
  );
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

class CodexAdapter extends BaseAdapter {
  constructor(options = {}) {
    super("codex", options);
    this.sessionsDir = options.sessionsDir || CODEX_DIR;
    this.cli = options.cli || CODEX_CLI;
    this.S = new Map();
    this.listing = [];
    this.listedAt = 0;
  }

  owns(sid) {
    return (
      [...this.S.values()].some((st) => st.id === sid) ||
      fs.existsSync(path.join(this.sessionsDir, `${sid}.jsonl`)) ||
      fs.existsSync(path.join(this.sessionsDir, `${sid}.json`))
    );
  }

  fresh(file, id) {
    return {
      file,
      id,
      harness: "codex",
      off: 0,
      partial: false,
      mtime: 0,
      size: 0,
      title: "",
      agent: "",
      first: "",
      prompt: "",
      promptFull: "",
      promptAt: 0,
      cwd: "",
      branch: "",
      entry: "codex-cli",
      model: "gpt-4o",
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
    };
  }

  feed(st, o) {
    if (!o || typeof o !== "object") return;
    const at = o.timestamp ? Date.parse(o.timestamp) || st.mtime : st.mtime;

    const role = o.role || o.source;
    if (role === "user") {
      const text = typeof o.content === "string" ? o.content : JSON.stringify(o.content || "");
      if (!st.first) st.first = one(text, 240);
      st.prompt = one(text, 240);
      st.promptFull = text.slice(0, 4000);
      st.promptAt = at;
      st.last = { k: "prompt", at };
      st.lastEvt = at;
      openTurn(st, at);
      return;
    }

    if (role === "assistant") {
      const stepId = `step-${st.ids.size + 1}`;
      st.ids.add(stepId);
      if (o.model) st.model = o.model;

      const u = o.usage || {};
      const inp = u.prompt_tokens || u.input_tokens || 0;
      const out = u.completion_tokens || u.output_tokens || 0;
      const c = u.cached_tokens || u.cache_read_tokens || 0;
      const ctx = inp + c;
      if (ctx) st.ctx = ctx;

      st.calls.set(stepId, {
        at,
        model: st.model,
        inp,
        cw: 0,
        i: inp,
        c,
        o: out,
        lat: 0,
      });

      if (Array.isArray(o.tool_calls) && o.tool_calls.length) {
        for (const tc of o.tool_calls) {
          const fn = tc.function || tc;
          const tn = fn.name || "tool";
          st.tool = { name: tn, what: one(fn.arguments || "", 90), at };
          let t = st.tools.get(tn);
          if (!t) {
            t = { uses: [], done: [] };
            st.tools.set(tn, t);
          }
          t.uses.push(at);
        }
        st.last = { k: "tool", at };
      }

      if (o.content && typeof o.content === "string" && o.content.trim()) {
        st.text = o.content.trim();
        st.textAt = at;
        if (!o.tool_calls || !o.tool_calls.length) {
          const isDone = /\[done\]/i.test(o.content);
          st.last = { k: isDone ? "done" : "done_turn", at };
          st.doneAt = at;
          closeTurn(st, at);
        }
      }
      st.lastEvt = at;
      return;
    }

    if (role === "tool" || role === "function") {
      st.last = { k: "result", at };
      st.lastEvt = at;
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
        if (!line || line.length < 5) continue;
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
    if (now - this.listedAt < 20e3 && this.listing.length) return;
    this.listedAt = now;
    const out = [];
    if (!fs.existsSync(this.sessionsDir)) return;
    let files = [];
    try {
      files = fs.readdirSync(this.sessionsDir);
    } catch {
      return;
    }

    for (const f of files) {
      if (!f.endsWith(".jsonl") && !f.endsWith(".json")) continue;
      const file = path.join(this.sessionsDir, f);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > 7 * DAY) continue;
      out.push({
        id: f.replace(/\.jsonl?$/, ""),
        file,
        mtime: st.mtimeMs,
      });
    }
    this.listing = out;
  }

  scan(now, board = new Map()) {
    this.relist(now);
    const sessions = [];

    for (const f of this.listing) {
      if (now - f.mtime > WINDOW) continue;
      let st = this.S.get(f.file);
      if (!st) {
        st = this.fresh(f.file, f.id);
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

      const age = now - st.mtime;
      const L = st.last || {};
      let state;

      if (L.k === "done") state = "finished";
      else if (L.k === "done_turn") state = age < 6 * HOUR ? "waiting" : "idle";
      else if (L.k === "tool" || L.k === "prompt") state = age < 10 * MIN ? "working" : "stopped";
      else state = age < 10 * MIN ? "working" : "closed";

      const turns = Math.max(st.ids.size, 1);
      pruneMetrics(st, now);

      let ti = 0,
        to = 0,
        tc = 0,
        cost = 0;
      for (const c of st.calls.values()) {
        ti += c.i;
        to += c.o;
        tc += c.c;
        cost += codexCostOf(c);
      }

      sessions.push({
        id: st.id,
        harness: "codex",
        kind: "codex",
        short: st.id.slice(0, 8),
        blocked: false,
        waitingFor: "",
        room: short(st.cwd || this.sessionsDir),
        repo: "",
        cwd: st.cwd || this.sessionsDir,
        helpers: [],
        metrics: {
          reqs: st.calls.size,
          in: ti,
          out: to,
          cache: tc,
          tools: [],
          cost,
          toolN: 0,
          toolErr: 0,
          commits: 0,
          prs: 0,
          add: 0,
          del: 0,
        },
        stuck: null,
        errLog: [],
        tl: st.turns
          .filter((t) => !t.e || now - t.e < 12 * HOUR)
          .map((t) => [t.s, t.e || st.mtime]),
        errAt: [],
        outAt: [],
        peers: [],
        title: st.title || st.agent || one(st.first, 70) || `Codex Agent (${st.id.slice(0, 8)})`,
        where: short(st.cwd || this.sessionsDir),
        branch: "",
        entry: "codex",
        model: st.model,
        state,
        question: false,
        since: st.promptAt || L.at || st.mtime,
        lastActive: st.mtime,
        activity:
          st.tool && state === "working"
            ? { name: st.tool.name, what: st.tool.what, at: st.tool.at }
            : null,
        said: one(plain(st.text), 420),
        prompt: one(st.prompt, 300),
        first: one(st.first, 300),
        turns,
        partial: st.partial,
        verdict: verdict(turns),
        ctx: st.ctx,
        errors10m: 0,
        subagents: 0,
        sched: "",
        peer: 0,
        files: [],
        transcript: short(st.file),
      });
    }

    return sessions;
  }

  async startAgent({ text, cwd, model }) {
    try {
      const child = cp.spawn(this.cli, ["run", "--prompt", text], {
        cwd: cwd || HOME,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return {
        ok: true,
        msg: `Started Codex agent in ${short(cwd || HOME)}`,
      };
    } catch (err) {
      return {
        ok: false,
        msg: `Could not start Codex agent: ${err.message}`,
      };
    }
  }

  // Agent HQ has no working channel into a Codex session yet (the supported ones are `codex app-server` and
  // hooks). These used to return ok: true without doing anything, so the UI reported messages as sent that
  // never were. Say so instead, and let the caller show the text for pasting.
  async deliver(sid, text) {
    return { ok: false, unsupported: true, msg: "Agent HQ cannot send messages to Codex sessions yet. Paste it into Codex yourself." };
  }

  async stop(sid) {
    return { ok: false, unsupported: true, msg: "Agent HQ cannot stop Codex sessions yet. Stop it in Codex." };
  }
}

module.exports = {
  CodexAdapter,
  codexPrice,
  codexCostOf,
};
