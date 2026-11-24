// Replays the dashboard's "loop thrashing" rule over local Claude transcripts. Aggregate output only.
// Rule under test (agents-ui/tray.js:19): errors in last 10 min >= 3  OR  errLog length >= 3,
// where errLog = failed tool results within the last 24 h (cap 60) (adapters/claude.js pruneMetrics).
// Proxy for a real loop: >= 3 consecutive failed results of the same tool with the same input hash within 15 min,
// with no successful result of that tool in between.
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");

const PROJ = path.join(process.env.USERPROFILE, ".claude", "projects");
const DAYS = Number(process.argv[2] || 7);
const MIN = 6e4, HOUR = 36e5, DAY = 24 * HOUR;
const now = Date.now();

function listTop() {
  const out = [];
  for (const d of fs.readdirSync(PROJ, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(PROJ, d.name))) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(PROJ, d.name, f);
      const st = fs.statSync(p);
      if (now - st.mtimeMs < DAYS * DAY) out.push({ p, size: st.size });
    }
  }
  return out;
}

async function parse(file) {
  const uses = new Map();           // tool_use_id -> {name, hash, at}
  const results = [];               // {at, name, hash, err}
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length < 20) continue;
    const isAsst = line.includes('"type":"assistant"'), isUser = line.includes('"type":"user"');
    if (!isAsst && !isUser) continue;
    if (isAsst && !line.includes('"tool_use"')) continue;
    if (isUser && !line.includes('"tool_result"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    const at = Date.parse(o.timestamp); if (!at) continue;
    const c = o.message && o.message.content; if (!Array.isArray(c)) continue;
    for (const x of c) {
      if (!x) continue;
      if (x.type === "tool_use") {
        const h = crypto.createHash("md5").update(JSON.stringify(x.input || {})).digest("hex").slice(0, 10);
        uses.set(x.id, { name: String(x.name), hash: h, at });
      } else if (x.type === "tool_result") {
        const u = uses.get(x.tool_use_id); if (!u) continue;
        results.push({ at, name: u.name, hash: u.hash, err: !!x.is_error });
      }
    }
  }
  results.sort((a, b) => a.at - b.at);
  return results;
}

(async () => {
  const files = listTop();
  const sampleStep = 10 * MIN;
  const tot = { files: files.length, resultsTotal: 0, errorsTotal: 0, sessionDays: 0, sessionDaysGe3: 0, samples: 0, flagged: 0, flagged10m: 0, flaggedOnly24h: 0, flaggedWithStrictLoop30m: 0, strictLoopSamples: 0, strictLoopNotFlagged: 0 };
  const errPerDay = [];
  for (const f of files) {
    const r = await parse(f.p);
    if (!r.length) continue;
    tot.resultsTotal += r.length; tot.errorsTotal += r.filter((x) => x.err).length;
    // session-days
    const byDay = new Map();
    for (const x of r) { const k = Math.floor(x.at / DAY); byDay.set(k, (byDay.get(k) || 0) + (x.err ? 1 : 0)); }
    for (const [, n] of byDay) { tot.sessionDays++; errPerDay.push(n); if (n >= 3) tot.sessionDaysGe3++; }
    // strict loop events: run of >=3 consecutive failures of same tool+hash (consecutive among results of that tool), spanning <= 15 min
    const strictAt = [];
    const lastByKey = new Map();
    for (const x of r) {
      const k = x.name;
      let st = lastByKey.get(k) || { run: [], };
      if (x.err) {
        const prev = st.run[st.run.length - 1];
        if (prev && prev.hash === x.hash && x.at - prev.at <= 15 * MIN) st.run.push(x); else st.run = [x];
        if (st.run.length >= 3) strictAt.push(x.at);
      } else st.run = [];
      lastByKey.set(k, st);
    }
    // sample at fixed times only while the session is active (some result within +/-10 min of sample)
    const t0 = r[0].at, t1 = r[r.length - 1].at;
    const ats = r.map((x) => x.at);
    for (let t = Math.ceil(t0 / sampleStep) * sampleStep; t <= t1; t += sampleStep) {
      // active = a tool result in (t-10min, t]
      let lo = 0, hi = ats.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ats[m] <= t) lo = m + 1; else hi = m; }
      const idx = lo - 1; if (idx < 0 || t - ats[idx] > 10 * MIN) continue;
      tot.samples++;
      let e10 = 0, e24 = 0;
      for (let i = idx; i >= 0 && t - ats[i] <= DAY; i--) { if (r[i].err) { e24++; if (t - ats[i] <= 10 * MIN) e10++; } }
      e24 = Math.min(e24, 60);
      const flag = e10 >= 3 || e24 >= 3;
      const strict = strictAt.some((a) => a <= t && t - a <= 30 * MIN);
      if (flag) { tot.flagged++; if (e10 >= 3) tot.flagged10m++; else tot.flaggedOnly24h++; if (strict) tot.flaggedWithStrictLoop30m++; }
      if (strict) { tot.strictLoopSamples++; if (!flag) tot.strictLoopNotFlagged++; }
    }
  }
  errPerDay.sort((a, b) => a - b);
  const q = (p) => errPerDay[Math.min(errPerDay.length - 1, Math.floor(p * errPerDay.length))];
  const pct = (a, b) => (b ? +(100 * a / b).toFixed(1) : null);
  console.log(JSON.stringify({
    windowDays: DAYS, transcripts: tot.files, toolResults: tot.resultsTotal, failedResults: tot.errorsTotal,
    failedPct: pct(tot.errorsTotal, tot.resultsTotal),
    sessionDays: tot.sessionDays, sessionDaysWith3plusErrors: tot.sessionDaysGe3, pctSessionDaysWith3plusErrors: pct(tot.sessionDaysGe3, tot.sessionDays),
    errorsPerSessionDay: { p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: errPerDay[errPerDay.length - 1] },
    activeSamples10min: tot.samples, flaggedSamples: tot.flagged, pctSamplesFlagged: pct(tot.flagged, tot.samples),
    flaggedBy10minRule: tot.flagged10m, flaggedOnlyBy24hRule: tot.flaggedOnly24h,
    flaggedSamplesWithStrictLoopInLast30min: tot.flaggedWithStrictLoop30m, precisionVsStrictProxy: pct(tot.flaggedWithStrictLoop30m, tot.flagged),
    strictLoopSamples: tot.strictLoopSamples, strictLoopSamplesNotFlagged: tot.strictLoopNotFlagged,
  }, null, 1));
})();
