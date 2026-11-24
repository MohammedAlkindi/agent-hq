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

const ANTIGRAVITY_DIR = path.join(HOME, ".gemini", "antigravity");
const BRAIN_DIR = path.join(ANTIGRAVITY_DIR, "brain");
const FULL_READ_MAX = 40 * 1024 * 1024;
const WINDOW = DAY;

const GEMINI_PRICES = [
  [/^gemini-3\.8-flash/, 0.10, 0.40, 0.025],
  [/^gemini-3\.8-pro/, 1.25, 5.00, 0.3125],
  [/^gemini-2\.5-pro/, 1.25, 5.00, 0.3125],
  [/^gemini-2\.5-flash/, 0.075, 0.30, 0.01875],
  [/^gemini-1\.5-pro/, 1.25, 5.00, 0.3125],
  [/^gemini-1\.5-flash/, 0.075, 0.30, 0.01875],
  [/^gemini-/, 0.10, 0.40, 0.025],
];

function geminiPrice(model) {
  const m = String(model || "").toLowerCase();
  const r = GEMINI_PRICES.find(([re]) => re.test(m));
  return r ? { i: r[1], o: r[2], cr: r[3] } : { i: 0.1, o: 0.4, cr: 0.025 };
}

function geminiCostOf(c) {
  const p = geminiPrice(c.model);
  return (
    ((c.inp || 0) * p.i +
      (c.cw || 0) * p.i * 2 +
      (c.c || 0) * p.cr +
      (c.o || 0) * p.o) /
    1e6
  );
}

function toolWhat(name, args) {
  args = args || {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = { raw: args };
    }
  }
  const v =
    args.toolSummary ||
    args.CommandLine ||
    args.Path ||
    args.query ||
    args.Prompt ||
    args.brief ||
    args.text ||
    args.Action ||
    args.Description ||
    args.Title ||
    "";
  return one(String(v).replace(/\r?\n/g, " "), 90);
}

function outputOf(name, args) {
  args = args || {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  if (name === "run_command") {
    const cmd = String(args.CommandLine || "");
    if (/\bgh\s+pr\s+create\b/.test(cmd)) return { k: "pr" };
    if (/\bgit\b[^\n|;&]*\scommit\b/.test(cmd) && !/--dry-run/.test(cmd))
      return { k: "commit" };
    return null;
  }
  if (name === "write_file") {
    return { k: "loc", add: nLines(args.Content), del: 0 };
  }
  if (name === "edit_file") {
    return {
      k: "loc",
      add: nLines(args.Replacement),
      del: nLines(args.Target),
    };
  }
  return null;
}

function cleanUserPrompt(content) {
  if (typeof content !== "string") return "";
  let text = content;
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  if (m) text = m[1].trim();
  text = text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .trim();
  return text;
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

function toolStat(st, name) {
  let t = st.tools.get(name);
  if (!t) {
    t = { uses: [], done: [] };
    st.tools.set(name, t);
  }
  return t;
}

class AntigravityAdapter extends BaseAdapter {
  constructor(options = {}) {
    super("antigravity", options);
    this.brainDir = options.brainDir || BRAIN_DIR;
    this.S = new Map(); // transcript path -> state
    this.listing = [];
    this.listedAt = 0;
  }

  owns(sid) {
    return (
      [...this.S.values()].some((st) => st.id === sid) ||
      fs.existsSync(path.join(this.brainDir, sid))
    );
  }

  fresh(file, id) {
    return {
      file,
      id,
      harness: "antigravity",
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
      entry: "antigravity",
      model: "gemini-3.8-flash",
      ctx: 0,
      ids: new Set(),
      tool: null,
      lastToolStart: 0,
      text: "",
      textAt: 0,
      last: null,
      asking: 0,
      errors: [],
      sched: "",
      peer: 0,
      doneAt: 0,
      calls: new Map(),
      tools: new Map(),
      peers: [],
      turns: [],
      lastEvt: 0,
      errLog: [],
      outs: [],
      pendingTools: new Map(),
      pending: new Map(),
    };
  }

  feed(st, o) {
    if (!o || typeof o !== "object") return;
    const at = o.created_at ? Date.parse(o.created_at) || st.mtime : st.mtime;

    // User input
    if (o.type === "USER_INPUT" || o.source === "USER_EXPLICIT" || o.source === "USER") {
      const text = cleanUserPrompt(o.content);
      if (text) {
        if (!st.first) st.first = one(text, 240);
        st.prompt = one(text, 240);
        st.promptFull = text.slice(0, 4000);
        st.promptAt = at;
        st.asking = 0;
      }
      st.last = { k: "prompt", at };
      st.lastEvt = at;
      openTurn(st, at);
      return;
    }

    // System message
    if (o.type === "SYSTEM_MESSAGE" || o.source === "SYSTEM") {
      const txt = String(o.content || "");
      const swarmMatch = /assignment \(recorded on the board as #\d+ for @([a-zA-Z0-9_-]+)\)/i.exec(txt);
      if (swarmMatch) {
        st.agent = "@" + swarmMatch[1];
        if (!st.title) st.title = `Swarm: @${swarmMatch[1]}`;
      }
      if (/\[done\]/i.test(txt)) {
        st.last = { k: "done", at };
        st.doneAt = at;
        closeTurn(st, at);
      }
      return;
    }

    // Error message
    if (o.type === "ERROR_MESSAGE" || o.status === "ERROR") {
      st.errors.push(at);
      const errStr = one(o.error || o.content || "Error", 200);
      st.errLog.push({ at, tool: (st.tool && st.tool.name) || "system", text: errStr });
      if (st.errLog.length > 60) st.errLog.shift();
      st.last = { k: "error", at };
      st.lastEvt = at;
      return;
    }

    // Model Planner Response
    if (o.type === "PLANNER_RESPONSE" || o.source === "MODEL") {
      if (o.model) st.model = o.model;
      const stepKey = `step-${o.step_index != null ? o.step_index : at}`;
      st.ids.add(stepKey);

      const inp = o.input_tokens || 0;
      const out = o.output_tokens || 0;
      const c = o.cache_read_tokens || 0;
      const ctx = inp + c;
      if (ctx) st.ctx = ctx;

      const lat = st.lastEvt && at > st.lastEvt && at - st.lastEvt < 20 * MIN ? at - st.lastEvt : 0;
      st.calls.set(stepKey, {
        at,
        model: st.model,
        inp,
        cw: 0,
        i: inp,
        c,
        o: out,
        lat,
      });

      let hasTools = false;
      if (Array.isArray(o.tool_calls) && o.tool_calls.length) {
        hasTools = true;
        for (const tc of o.tool_calls) {
          if (!tc || !tc.name) continue;
          const tn = tc.name;
          const what = toolWhat(tn, tc.args);
          st.tool = { name: tn, what, at };
          st.lastToolStart = at;
          toolStat(st, tn).uses.push(at);

          if (tn === "ask_question" || tn === "ask_user_question") {
            st.asking = at;
          }

          const outProd = outputOf(tn, tc.args);
          if (outProd) {
            st.outs.push({ at, ...outProd });
            if (st.outs.length > 2000) st.outs.shift();
          }
        }
        st.last = { k: "tool", at };
      }

      if (o.content && typeof o.content === "string" && o.content.trim()) {
        st.text = o.content.trim();
        st.textAt = at;
        if (!hasTools) {
          const isFinished = /\[done\]/i.test(o.content) || /All requested tasks (have been )?completed/i.test(o.content);
          st.last = { k: isFinished ? "done" : "done_turn", at };
          st.doneAt = at;
          closeTurn(st, at);
        }
      }
      st.lastEvt = at;
      return;
    }

    // Generic Tool Result
    if (o.type === "GENERIC") {
      const err = o.status === "ERROR" || /Command exited with code [1-9]|Exit code [1-9]/i.test(String(o.content || ""));
      if (err) st.errors.push(at);
      if (st.tool) {
        const tn = st.tool.name;
        const dur = Math.max(0, at - (st.lastToolStart || at));
        toolStat(st, tn).done.push([at, dur, err ? 1 : 0]);
        if (err) {
          st.errLog.push({ at, tool: tn, text: one(String(o.content || "tool error"), 200) });
          if (st.errLog.length > 60) st.errLog.shift();
        }
      }
      st.last = { k: "result", at, err };
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
        if (!line || line.length < 10) continue;
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
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.brainDir, { withFileTypes: true }).filter((d) =>
        d.isDirectory()
      );
    } catch {}

    for (const d of dirs) {
      const transPath = path.join(
        this.brainDir,
        d.name,
        ".system_generated",
        "logs",
        "transcript.jsonl"
      );
      let st;
      try {
        st = fs.statSync(transPath);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > 7 * DAY) continue;
      out.push({
        id: d.name,
        file: transPath,
        dir: path.join(this.brainDir, d.name),
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

      if (L.k === "done") {
        state = "finished";
      } else if (L.k === "done_turn") {
        state = age < 6 * HOUR ? "waiting" : age < DAY ? "idle" : "closed";
      } else if (L.k === "tool" || L.k === "prompt" || L.k === "result") {
        state = age < 10 * MIN ? "working" : age < 2 * HOUR ? "quiet" : "stopped";
      } else {
        state = age < 10 * MIN ? "working" : age < 6 * HOUR ? "waiting" : "closed";
      }

      if (state === "idle" && st.ids.size <= 1) continue;

      const turns = Math.max(st.ids.size, 1);
      const question =
        state === "waiting" && (st.asking > 0 || /\?\s*$/.test(st.text));
      const b = board.get(st.id);

      pruneMetrics(st, now);
      let ti = 0,
        to = 0,
        tc = 0,
        cost = 0;
      for (const c of st.calls.values()) {
        ti += c.i;
        to += c.o;
        tc += c.c;
        cost += geminiCostOf(c);
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

      const title =
        st.title ||
        st.agent ||
        one(st.first, 70) ||
        `Antigravity Agent (${st.id.slice(0, 8)})`;

      sessions.push({
        id: st.id,
        harness: "antigravity",
        kind: "antigravity",
        short: st.id.slice(0, 8),
        blocked: false,
        waitingFor: "",
        room: short(st.cwd || f.dir),
        repo: b && b.repo ? short(b.repo) : "",
        cwd: st.cwd || f.dir,
        helpers: [],
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
        title,
        where: short(st.cwd || f.dir),
        branch: st.branch,
        entry: "antigravity",
        model: st.model,
        state,
        question,
        since:
          state === "working" || state === "quiet"
            ? st.promptAt || L.at
            : L.at || st.mtime,
        lastActive: st.mtime,
        activity:
          st.tool &&
          state !== "waiting" &&
          state !== "idle" &&
          state !== "finished"
            ? { name: st.tool.name, what: st.tool.what, at: st.tool.at }
            : null,
        said: one(plain(st.text), 420),
        prompt: one(st.prompt, 300),
        first: one(st.first, 300),
        turns,
        partial: st.partial,
        verdict: verdict(turns),
        ctx: st.ctx,
        errors10m: st.errors.filter((t) => now - t < 10 * MIN).length,
        subagents: 0,
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

    return sessions;
  }

  async startAgent({ text, cwd, model }) {
    const geminiCmd = path.join(
      HOME,
      "AppData",
      "Roaming",
      "npm",
      process.platform === "win32" ? "gemini.cmd" : "gemini"
    );
    const agyExe = path.join(
      HOME,
      "AppData",
      "Local",
      "Programs",
      "antigravity",
      "Antigravity.exe"
    );

    const m = model || "gemini-3.8-flash";
    if (fs.existsSync(geminiCmd)) {
      try {
        const child = cp.spawn(geminiCmd, ["--model", m, "--prompt", text], {
          cwd: cwd || HOME,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
        return {
          ok: true,
          msg: `Started Antigravity agent in ${short(cwd || HOME)} via gemini CLI`,
        };
      } catch (err) {
        return {
          ok: false,
          msg: `Could not start Antigravity agent: ${err.message}`,
        };
      }
    }

    if (fs.existsSync(agyExe)) {
      try {
        const child = cp.spawn(agyExe, [cwd || HOME], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        return {
          ok: true,
          msg: `Opened Antigravity workspace for ${short(cwd || HOME)}`,
        };
      } catch (err) {
        return {
          ok: false,
          msg: `Could not launch Antigravity: ${err.message}`,
        };
      }
    }

    return {
      ok: false,
      msg: "Antigravity CLI or desktop executable not found on host path.",
    };
  }

  // No working channel into an Antigravity session yet (its hooks and `agy` headless mode are the candidates).
  // These used to answer "Message queued" and "marked stopped" while doing nothing.
  async deliver(sid, text) {
    const st = [...this.S.values()].find((x) => x.id === sid);
    if (!st) return { ok: false, msg: `Antigravity session "${sid}" not found.` };
    return {
      ok: false,
      unsupported: true,
      msg: `Agent HQ cannot send messages to Antigravity sessions yet. Paste it into "${st.title || sid.slice(0, 8)}" yourself.`,
    };
  }

  async stop(sid) {
    const st = [...this.S.values()].find((x) => x.id === sid);
    if (!st) return { ok: false, msg: `Antigravity session "${sid}" not found.` };
    return {
      ok: false,
      unsupported: true,
      msg: "Agent HQ cannot stop Antigravity sessions yet. Stop it in Antigravity.",
    };
  }
}

module.exports = {
  AntigravityAdapter,
  geminiPrice,
  geminiCostOf,
};
