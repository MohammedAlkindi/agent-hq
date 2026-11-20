"use strict";

const os = require("os");
const path = require("path");

const HOME = os.homedir();
const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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

const nLines = (s) => (typeof s === "string" && s.length ? s.split("\n").length : 0);

function verdict(turns) {
  if (turns <= 300) return { level: "ok", text: "keep going" };
  if (turns <= 800) return { level: "warn", text: "close soon · 1.65x rate" };
  return { level: "crit", text: "close now · 2.4x rate" };
}

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

class BaseAdapter {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
  }

  // Returns array of normalized session objects
  async scan(now) {
    throw new Error("scan() must be implemented by adapter");
  }

  // Returns true if this adapter owns or recognizes the session ID
  owns(sid) {
    return false;
  }

  // Starts a new agent under this harness
  async startAgent({ text, cwd, model }) {
    return { ok: false, msg: `startAgent not supported for ${this.name}` };
  }

  // Delivers message to a running or waking agent
  async deliver(sid, text) {
    return { ok: false, msg: `deliver not supported for ${this.name}` };
  }

  // Stops an agent
  async stop(sid) {
    return { ok: false, msg: `stop not supported for ${this.name}` };
  }

  // Attaches terminal window to agent
  attach(sid) {
    return { ok: false, msg: `attach not supported for ${this.name}` };
  }
}

module.exports = {
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
};
