// Human response gaps vs agent work times from local transcripts (7 days). Aggregate only.
"use strict";
const fs = require("fs"), path = require("path"), readline = require("readline");
const PROJ = path.join(process.env.USERPROFILE, ".claude", "projects");
const DAYS = Number(process.argv[2] || 7), DAY = 864e5, MIN = 6e4, now = Date.now();
const files = [];
for (const d of fs.readdirSync(PROJ, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(PROJ, d.name))) { if (!f.endsWith(".jsonl")) continue; const p = path.join(PROJ, d.name, f); if (now - fs.statSync(p).mtimeMs < DAYS * DAY) files.push(p); }
}
const humanText = (c) => {
  const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x && x.type === "text").map((x) => x.text).join("\n") : "";
  const s = t.trim(); if (!s) return null;
  if (s.startsWith("<") || s.startsWith("[Request interrupted") || /^\[[^\]]{0,80}(notice|session|comment|event)/i.test(s)) return null;
  return s;
};
(async () => {
  const work = [], gaps = [], gapsNoOvernight = [];
  let sessionsWithHuman = 0, scheduled = 0, turns = 0;
  for (const f of files) {
    let promptAt = 0, doneAt = 0, sched = false, hadHuman = false, lastWasUserTool = false;
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      const isU = line.includes('"type":"user"'), isA = line.includes('"type":"assistant"');
      if (!isU && !isA) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.isSidechain || o.isMeta) continue;
      const at = Date.parse(o.timestamp); if (!at) continue;
      const m = o.message || {};
      if (o.type === "user") {
        const c = m.content;
        if (Array.isArray(c) && c.some((x) => x && x.type === "tool_result")) continue;
        const raw = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x && x.type === "text").map((x) => x.text).join("\n") : "";
        if (raw.trim().startsWith("<scheduled-task")) { sched = true; }
        const h = humanText(c);
        if (!h) continue;
        if (doneAt && !sched) { const g = at - doneAt; if (g >= 0) { gaps.push(g); if (g < 12 * 36e5) gapsNoOvernight.push(g); } }
        promptAt = at; doneAt = 0; hadHuman = true;
      } else if (o.type === "assistant") {
        const hasTool = Array.isArray(m.content) && m.content.some((x) => x && x.type === "tool_use");
        if (!hasTool && m.stop_reason && m.stop_reason !== "tool_use") { if (promptAt && !sched) { work.push(at - promptAt); turns++; } doneAt = at; promptAt = 0; }
      }
    }
    if (sched) scheduled++; else if (hadHuman) sessionsWithHuman++;
  }
  const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +(s[Math.min(s.length - 1, Math.floor(p * s.length))] / MIN).toFixed(1); };
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const bucket = (lo, hi) => { const g = gapsNoOvernight.filter((x) => x >= lo * MIN && x < hi * MIN); return { n: g.length, shareOfWaitMinutes: +(sum(g) / sum(gapsNoOvernight)).toFixed(2) }; };
  console.log(JSON.stringify({ waitShareByGapBucket_under12h: { lt5m: bucket(0, 5), m5to30: bucket(5, 30), m30to120: bucket(30, 120), gt120m: bucket(120, 1e9) },
    transcripts: files.length, interactiveSessions: sessionsWithHuman, scheduledSessionsExcluded: scheduled, completedAgentTurns: turns,
    agentTurnMinutes: { p25: q(work, 0.25), median: q(work, 0.5), p75: q(work, 0.75), p90: q(work, 0.9), mean: +(sum(work) / (work.length || 1) / MIN).toFixed(1) },
    humanReplyGapMinutes_all: { n: gaps.length, p25: q(gaps, 0.25), median: q(gaps, 0.5), p75: q(gaps, 0.75), p90: q(gaps, 0.9) },
    humanReplyGapMinutes_under12h: { n: gapsNoOvernight.length, p25: q(gapsNoOvernight, 0.25), median: q(gapsNoOvernight, 0.5), p75: q(gapsNoOvernight, 0.75), p90: q(gapsNoOvernight, 0.9), mean: +(sum(gapsNoOvernight) / (gapsNoOvernight.length || 1) / MIN).toFixed(1) },
    fractionGapsOver30min_under12h: +(gapsNoOvernight.filter((g) => g > 30 * MIN).length / (gapsNoOvernight.length || 1)).toFixed(2),
    agentBusyToHumanGapMeanRatio_under12h: +((sum(work) / (work.length || 1)) / (sum(gapsNoOvernight) / (gapsNoOvernight.length || 1))).toFixed(2),
  }, null, 1));
})();
