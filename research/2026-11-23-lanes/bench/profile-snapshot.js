// CPU-profiles snapshot() of the baseline server code on a synthetic fleet. usage: node --cpu-prof --cpu-prof-dir=<d> profile-snapshot.js <benchHome>
"use strict";
const fs = require("fs"), path = require("path");
const home = process.argv[2];
process.env.USERPROFILE = home; process.env.HOME = home;
const root = path.dirname(__filename);
const hq = require(path.join(root, "baseline", "agent-hq", "agent-dashboard.js"));
const proj = path.join(home, ".claude", "projects", "C--bench");
const files = fs.readdirSync(proj).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(proj, f));
const line = (i) => JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), cwd: "C:\\bench", message: { id: "msg_p" + i + Math.random().toString(36).slice(2), model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: "t" + Math.random().toString(36).slice(2), name: "Bash", input: { command: "x", description: "profile" } }], stop_reason: "tool_use", usage: { input_tokens: 5, cache_read_input_tokens: 90000, cache_creation_input_tokens: 10, output_tokens: 50 } } }) + "\n";
for (let i = 0; i < 5; i++) hq.snapshot();
const times = []; let bytes = 0;
for (let r = 0; r < 40; r++) {
  for (const f of files.slice(0, 8)) fs.appendFileSync(f, line(r));
  const t0 = process.hrtime.bigint();
  const s = hq.snapshot();
  const t1 = process.hrtime.bigint();
  const t2 = process.hrtime.bigint(); const j = JSON.stringify(s); const t3 = process.hrtime.bigint();
  times.push([Number(t1 - t0) / 1e6, Number(t3 - t2) / 1e6]); bytes = j.length;
}
const snap = times.map((x) => x[0]).sort((a, b) => a - b), ser = times.map((x) => x[1]).sort((a, b) => a - b);
console.log(JSON.stringify({ sessions: files.length, snapshotMs: { p50: +snap[20].toFixed(1), p95: +snap[37].toFixed(1) }, stringifyMs: { p50: +ser[20].toFixed(1) }, jsonKB: +(bytes / 1024).toFixed(0) }));
process.exit(0);
