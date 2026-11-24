// Compares deduped API-equivalent cost of main transcripts vs subagent transcripts (7 days), using Agent HQ's own price table.
"use strict";
const fs = require("fs"), path = require("path"), readline = require("readline");
const { costOf } = require("./baseline/agent-hq/adapters/claude.js");
const PROJ = path.join(process.env.USERPROFILE, ".claude", "projects");
const DAYS = Number(process.argv[2] || 7), DAY = 864e5, now = Date.now();
const main = [], sub = [];
for (const d of fs.readdirSync(PROJ, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const dir = path.join(PROJ, d.name);
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isFile() && f.name.endsWith(".jsonl") && now - fs.statSync(p).mtimeMs < DAYS * DAY) main.push(p);
    if (f.isDirectory()) {
      const sd = path.join(p, "subagents");
      if (!fs.existsSync(sd)) continue;
      for (const g of fs.readdirSync(sd)) if (g.endsWith(".jsonl")) { const q = path.join(sd, g); if (now - fs.statSync(q).mtimeMs < DAYS * DAY) sub.push(q); }
    }
  }
}
async function total(files) {
  let cost = 0, calls = 0, out = 0, unpriced = 0;
  const seen = new Set();
  for (const f of files) {
    const msgs = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const m = o.message || {}, u = m.usage; if (!u || !m.id || !m.model || /synthetic/i.test(m.model)) continue;
      msgs.set(m.id, { model: m.model.replace(/^claude-/, ""), inp: u.input_tokens || 0, cw: u.cache_creation_input_tokens || 0, c: u.cache_read_input_tokens || 0, o: u.output_tokens || 0 });
    }
    for (const [id, c] of msgs) { if (seen.has(id)) continue; seen.add(id); const k = costOf(c); if (!k) unpriced++; cost += k; calls++; out += c.o; }
  }
  return { files: files.length, calls, outputTokens: out, apiEquivalentUsd: +cost.toFixed(2), unpricedCalls: unpriced };
}
(async () => {
  const m = await total(main), s = await total(sub);
  console.log(JSON.stringify({ main: m, subagents: s, subagentShareOfTotalUsd: +(100 * s.apiEquivalentUsd / (m.apiEquivalentUsd + s.apiEquivalentUsd)).toFixed(1) }, null, 1));
})();
