// Replays the NEW detectors (detectors.js) over local Claude transcripts and reports how often they fire,
// next to the old rule's rate from replay-loop.js. Aggregate output only; no transcript text is printed.
// usage: USERPROFILE=<home> node replay-detector.js [days]
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const detectors = require(path.join(__dirname, "..", "..", "..", "detectors.js"));

const PROJ = path.join(process.env.USERPROFILE, ".claude", "projects");
const DAYS = Number(process.argv[2] || 7);
const MIN = 6e4, DAY = 864e5, now = Date.now();

const files = [];
for (const d of fs.readdirSync(PROJ, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(PROJ, d.name))) {
    if (!f.endsWith(".jsonl")) continue;
    const p = path.join(PROJ, d.name, f);
    if (now - fs.statSync(p).mtimeMs < DAYS * DAY) files.push(p);
  }
}

const humanPrompt = (c) => {
  if (Array.isArray(c) && c.some((x) => x && x.type === "tool_result")) return false;
  const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x && x.type === "text").map((x) => x.text).join("\n") : "";
  const s = t.trim();
  return !!s && !s.startsWith("<") && !s.startsWith("[Request interrupted");
};
const text = (x) => (typeof x.content === "string" ? x.content : Array.isArray(x.content) ? x.content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ") : "").replace(/\s+/g, " ").trim().slice(0, 160);

(async () => {
  const tot = { files: files.length, samples: 0, flagged: 0, alarm: 0, watch: 0, byId: {}, sessionsWithAlarm: 0, sessions: 0 };
  for (const f of files) {
    const events = [], pending = new Map(), timeline = []; // timeline: [t, finding]
    let any = false, alarmSeen = false;
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      const isA = line.includes('"type":"assistant"'), isU = line.includes('"type":"user"');
      if (!isA && !isU) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.isSidechain || o.isMeta) continue;
      const at = Date.parse(o.timestamp); if (!at) continue;
      const c = o.message && o.message.content;
      if (o.type === "user") {
        if (humanPrompt(c)) { events.length = 0; continue; }
        if (!Array.isArray(c)) continue;
        for (const x of c) {
          if (!x || x.type !== "tool_result") continue;
          const p = pending.get(x.tool_use_id); if (!p) continue;
          const tx = text(x);
          events.push({ name: p.name, hash: p.hash, ok: !x.is_error, err: x.is_error ? detectors.hashOf(tx) : "", out: x.is_error ? "" : detectors.hashOf(tx), poll: p.poll });
          if (events.length > detectors.WINDOW) events.shift();
          timeline.push([at, detectors.detect(events)]);
          any = true;
        }
      } else if (Array.isArray(c)) {
        for (const x of c) if (x && x.type === "tool_use") {
          const name = String(x.name).startsWith("mcp__") ? String(x.name).split("__").slice(-1)[0] : String(x.name);
          pending.set(x.id, { name, hash: detectors.hashOf(JSON.stringify(x.input || {})), poll: detectors.isPoll(name, x.input) });
        }
      }
    }
    if (!any) continue;
    tot.sessions++;
    // sample every 10 minutes while active, like replay-loop.js: the finding as of the last result before the sample
    const t0 = timeline[0][0], t1 = timeline[timeline.length - 1][0];
    let i = 0;
    for (let t = Math.ceil(t0 / (10 * MIN)) * 10 * MIN; t <= t1; t += 10 * MIN) {
      while (i + 1 < timeline.length && timeline[i + 1][0] <= t) i++;
      if (timeline[i][0] > t || t - timeline[i][0] > 10 * MIN) continue;
      tot.samples++;
      const fd = timeline[i][1];
      if (fd) { tot.flagged++; tot[fd.severity]++; tot.byId[fd.id] = (tot.byId[fd.id] || 0) + 1; if (fd.severity === "alarm") alarmSeen = true; }
    }
    if (alarmSeen) tot.sessionsWithAlarm++;
  }
  const pct = (a, b) => (b ? +(100 * a / b).toFixed(1) : null);
  console.log(JSON.stringify({
    windowDays: DAYS, transcriptsWithToolCalls: tot.sessions, activeSamples10min: tot.samples,
    flaggedSamples: tot.flagged, pctSamplesFlagged: pct(tot.flagged, tot.samples),
    alarmSamples: tot.alarm, pctSamplesAlarm: pct(tot.alarm, tot.samples), watchSamples: tot.watch,
    byFinding: tot.byId, sessionsThatEverHadAnAlarm: tot.sessionsWithAlarm,
  }, null, 1));
})();
