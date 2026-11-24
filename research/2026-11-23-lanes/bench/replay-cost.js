// Quantifies transcript usage double counting: naive sum over assistant rows vs one row per message id (latest wins).
// Aggregate output only. usage: node replay-cost.js <days>
"use strict";
const fs = require("fs"), path = require("path"), readline = require("readline");
const PROJ = path.join(process.env.USERPROFILE, ".claude", "projects");
const DAYS = Number(process.argv[2] || 7), DAY = 864e5, now = Date.now();
const files = [];
for (const d of fs.readdirSync(PROJ, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(PROJ, d.name))) {
    if (!f.endsWith(".jsonl")) continue;
    const p = path.join(PROJ, d.name, f);
    if (now - fs.statSync(p).mtimeMs < DAYS * DAY) files.push(p);
  }
}
(async () => {
  const T = { rows: 0, uniq: 0, naive: { out: 0, cr: 0, cw: 0, inp: 0 }, dedup: { out: 0, cr: 0, cw: 0, inp: 0 }, maxRowsPerMsg: 0, streamingUndercount: 0 };
  const rowsPerMsg = [];
  for (const f of files) {
    const msgs = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.isSidechain) continue;
      const m = o.message || {}; const u = m.usage; if (!u || !m.id) continue;
      const r = { out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0, inp: u.input_tokens || 0 };
      T.rows++; for (const k of Object.keys(r)) T.naive[k] += r[k];
      const e = msgs.get(m.id) || { n: 0, last: r, maxOut: 0 };
      e.n++; e.last = r; e.maxOut = Math.max(e.maxOut, r.out); msgs.set(m.id, e);
    }
    for (const e of msgs.values()) { T.uniq++; for (const k of Object.keys(e.last)) T.dedup[k] += e.last[k]; rowsPerMsg.push(e.n); if (e.last.out < e.maxOut) T.streamingUndercount++; }
  }
  rowsPerMsg.sort((a, b) => a - b);
  const q = (p) => rowsPerMsg[Math.min(rowsPerMsg.length - 1, Math.floor(p * rowsPerMsg.length))];
  const ratio = (a, b) => (b ? +(a / b).toFixed(2) : null);
  console.log(JSON.stringify({
    transcripts: files.length, assistantRowsWithUsage: T.rows, uniqueMessageIds: T.uniq, rowsPerMessage: { median: q(0.5), p90: q(0.9), max: rowsPerMsg[rowsPerMsg.length - 1] },
    naiveOverDeduped: { output: ratio(T.naive.out, T.dedup.out), cacheRead: ratio(T.naive.cr, T.dedup.cr), cacheWrite: ratio(T.naive.cw, T.dedup.cw), input: ratio(T.naive.inp, T.dedup.inp) },
    dedupedTotals: T.dedup, messagesWhereLastRowOutputBelowMax: T.streamingUndercount,
  }, null, 1));
})();
