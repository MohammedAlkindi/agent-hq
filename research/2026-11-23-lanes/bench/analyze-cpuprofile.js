// Aggregates self time per function from a .cpuprofile. usage: node analyze-cpuprofile.js <file> [top]
"use strict";
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const top = Number(process.argv[3] || 18);
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = p.timeDeltas; let total = 0;
p.samples.forEach((id, i) => { const d = dt[i] || 0; total += d; self.set(id, (self.get(id) || 0) + d); });
const agg = new Map();
for (const [id, t] of self) {
  const n = byId.get(id); const cf = n.callFrame;
  const key = `${cf.functionName || "(anonymous)"} ${String(cf.url || "").split(/[\\/]/).slice(-2).join("/")}:${cf.lineNumber + 1}`;
  agg.set(key, (agg.get(key) || 0) + t);
}
const rows = [...agg].sort((a, b) => b[1] - a[1]).slice(0, top);
console.log("total sampled ms:", (total / 1000).toFixed(0));
for (const [k, t] of rows) console.log((t / 1000).toFixed(0).padStart(7) + " ms  " + (100 * t / total).toFixed(1).padStart(5) + "%  " + k);
