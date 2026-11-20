"use strict";

const { ClaudeAdapter, costOf: claudeCostOf } = require("./claude");
const { AntigravityAdapter, geminiCostOf } = require("./antigravity");
const { CodexAdapter, codexCostOf } = require("./codex");

const claude = new ClaudeAdapter();
const antigravity = new AntigravityAdapter();
const codex = new CodexAdapter();

const registry = new Map([
  ["claude", claude],
  ["antigravity", antigravity],
  ["codex", codex],
]);

function getAdapter(name) {
  const k = String(name || "").toLowerCase().trim();
  if (k === "gemini" || k === "agy") return antigravity;
  if (k === "generic" || k === "openai") return codex;
  return registry.get(k) || claude;
}

function findAdapterForSession(sid) {
  for (const adapter of registry.values()) {
    if (adapter.owns(sid)) return adapter;
  }
  return claude;
}

function parseHarnessFromPrompt(text, fallbackHarness = "claude") {
  let cleanText = String(text || "").trim();
  let harness = fallbackHarness || "claude";

  const m = /^\/(antigravity|agy|gemini|codex|generic|openai|claude|distribute|fanout|all)\b\s*/i.exec(cleanText);
  if (m) {
    const raw = m[1].toLowerCase();
    if (raw === "antigravity" || raw === "agy" || raw === "gemini") harness = "antigravity";
    else if (raw === "codex" || raw === "generic" || raw === "openai") harness = "codex";
    else if (raw === "claude") harness = "claude";
    else if (raw === "distribute" || raw === "fanout" || raw === "all") harness = "all";
    cleanText = cleanText.slice(m[0].length).trim();
  }
  return { harness, text: cleanText };
}

function scanAll(now, board = new Map()) {
  let claudeSessions = [];
  let agySessions = [];
  let codexSessions = [];
  try { claudeSessions = claude.scan(now, board); } catch {}
  try { agySessions = antigravity.scan(now, board); } catch {}
  try { codexSessions = codex.scan(now, board); } catch {}

  const all = [...claudeSessions, ...agySessions, ...codexSessions];

  const order = {
    working: 0,
    waiting: 1,
    quiet: 2,
    stopped: 3,
    finished: 4,
    idle: 5,
    closed: 6,
  };

  all.sort(
    (a, b) =>
      (order[a.state] || 99) - (order[b.state] || 99) ||
      (a.state === "waiting"
        ? (a.since || 0) - (b.since || 0)
        : (b.lastActive || 0) - (a.lastActive || 0))
  );

  return all;
}

async function startAgent({ harness, text, cwd, model }) {
  const parsed = parseHarnessFromPrompt(text, harness);
  const targetHarness = parsed.harness;
  const promptText = parsed.text;

  const adapter = getAdapter(targetHarness);
  return await adapter.startAgent({ text: promptText, cwd, model });
}

async function deliver(sid, text) {
  const adapter = findAdapterForSession(sid);
  return await adapter.deliver(sid, text);
}

async function stop(sid) {
  const adapter = findAdapterForSession(sid);
  return await adapter.stop(sid);
}

function attach(sid) {
  const adapter = findAdapterForSession(sid);
  return adapter.attach(sid);
}

function getAllStates() {
  const combined = new Map();
  for (const [k, v] of claude.S.entries()) combined.set(k, v);
  for (const [k, v] of antigravity.S.entries()) combined.set(k, v);
  for (const [k, v] of codex.S.entries()) combined.set(k, v);
  return combined;
}

module.exports = {
  claude,
  antigravity,
  codex,
  registry,
  getAdapter,
  findAdapterForSession,
  parseHarnessFromPrompt,
  scanAll,
  startAgent,
  deliver,
  stop,
  attach,
  getAllStates,
  claudeCostOf,
  geminiCostOf,
  codexCostOf,
};
