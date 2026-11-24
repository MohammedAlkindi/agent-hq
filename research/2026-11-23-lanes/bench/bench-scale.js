// Synthetic scale benchmark of the BASELINE Agent HQ server (clone under scratchpad/baseline), fake HOME.
// usage: node bench-scale.js <scratchRoot> <nSessions> <kActive> <seconds> <port> [fileKB]
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const http = require("http");
const crypto = require("crypto");
const { performance } = require("perf_hooks");

const [root, nS, kA, secs, port, fileKB] = [process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], +process.argv[6], +(process.argv[7] || 2048)];
const home = path.join(root, `bench-home-${nS}-${Date.now().toString(36)}`);
const proj = path.join(home, ".claude", "projects", "C--bench");
fs.mkdirSync(proj, { recursive: true });
const iso = (t) => new Date(t).toISOString();
const uid = () => crypto.randomUUID();
const filler = "x".repeat(600);

function toolPair(t, mark, i) {
  const tid = "toolu_" + uid().replace(/-/g, "").slice(0, 20), mid = "msg_" + uid().replace(/-/g, "").slice(0, 20);
  const a = { type: "assistant", timestamp: iso(t), cwd: "C:\\bench", gitBranch: "main", message: { id: mid, model: "claude-opus-5-5", role: "assistant",
    content: [{ type: "tool_use", id: tid, name: "Bash", input: { command: "echo " + i, description: mark } }], stop_reason: "tool_use",
    usage: { input_tokens: 5, cache_read_input_tokens: 90000 + i, cache_creation_input_tokens: 100, output_tokens: 80 } } };
  const u = { type: "user", timestamp: iso(t + 400), cwd: "C:\\bench", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: filler, is_error: i % 23 === 0 }] } };
  return JSON.stringify(a) + "\n" + JSON.stringify(u) + "\n";
}
const files = [];
const target = fileKB * 1024;
for (let s = 0; s < nS; s++) {
  const f = path.join(proj, uid() + ".jsonl");
  let t = Date.now() - 3 * 3600e3 - s * 1000, body = JSON.stringify({ type: "user", timestamp: iso(t), cwd: "C:\\bench", gitBranch: "main", message: { role: "user", content: "bench task " + s } }) + "\n", i = 0;
  while (body.length < target) { t += 2000; body += toolPair(t, "bench step " + i, i); i++; }
  fs.writeFileSync(f, body); files.push({ f, i, t: Date.now() });
}
const env = { ...process.env, USERPROFILE: home, HOME: home, AGENT_DASH_PORT: String(port) };
const srv = cp.spawn(process.execPath, [path.join(root, "baseline", "agent-hq", "agent-dashboard.js"), "--serve"], { env, stdio: "ignore", windowsHide: true });
const cpuSecs = (pid) => +cp.execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`], { encoding: "utf8" }).trim();
const memMB = (pid) => +cp.execFileSync("powershell.exe", ["-NoProfile", "-Command", `[math]::Round((Get-Process -Id ${pid}).WorkingSet64/1MB,1)`], { encoding: "utf8" }).trim();
const get = (p) => new Promise((res, rej) => { const t0 = performance.now(); http.get({ host: "127.0.0.1", port, path: p }, (r) => { let n = 0; r.on("data", (c) => n += c.length); r.on("end", () => res({ ms: performance.now() - t0, bytes: n, code: r.statusCode })); }).on("error", rej); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(1); };

(async () => {
  for (let i = 0; i < 60; i++) { try { const r = await get("/api/ping"); if (r.code === 200) break; } catch {} await sleep(250); }
  await get("/api/state");                                  // warm
  const cold = [];
  for (let i = 0; i < 25; i++) { cold.push((await get("/api/state")).ms); }
  const sz = (await get("/api/state")).bytes;
  // SSE client with marker latency
  const pending = new Map(), lat = [], pushes = []; let sseBytes = 0, logLines = 0, buf = "";
  const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (r) => {
    r.setEncoding("utf8");
    r.on("data", (c) => {
      sseBytes += Buffer.byteLength(c); buf += c;
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const now = performance.now();
        if (ev.startsWith("event: state")) {
          pushes.push(now);
          for (const [m, t0] of pending) if (ev.includes(m)) { lat.push(now - t0); pending.delete(m); }
        } else if (ev.startsWith("event: log_line")) logLines++;
      }
    });
  });
  await sleep(1500);
  const pid = srv.pid; const c0 = cpuSecs(pid); const w0 = performance.now();
  const end = w0 + secs * 1000; let n = 0; const active = files.slice(0, kA);
  const timer = setInterval(() => {
    for (const a of active) {                       // each active session appends a step every ~1.5 s
      if (Math.random() < 0.66) continue;
      const mark = "MK" + (++n).toString(36) + Math.random().toString(36).slice(2, 6);
      fs.appendFileSync(a.f, toolPair(Date.now(), mark, ++a.i));
      pending.set(mark, performance.now());
    }
  }, 500);
  const probes = [];
  while (performance.now() < end) { probes.push((await get("/api/ping")).ms); await sleep(100); }
  clearInterval(timer);
  await sleep(2500);
  const c1 = cpuSecs(pid); const elapsed = (performance.now() - w0) / 1000; const mem = memMB(pid);
  const gaps = pushes.slice(1).map((t, i) => t - pushes[i]);
  console.log(JSON.stringify({
    sessions: nS, activeWriters: kA, fileKB, totalMB: +(files.length * fileKB / 1024).toFixed(0),
    stateGetMs: { mean: +(cold.reduce((a, b) => a + b, 0) / cold.length).toFixed(1), p95: pct(cold, 0.95), max: pct(cold, 1) }, stateKB: +(sz / 1024).toFixed(1),
    serverCpuPct: +(100 * (c1 - c0) / elapsed).toFixed(1), serverMemMB: mem,
    sse: { pushes: pushes.length, perSec: +(pushes.length / elapsed).toFixed(2), kbPerSec: +(sseBytes / 1024 / elapsed).toFixed(0), logLineEvents: logLines },
    appendToUiLatencyMs: { n: lat.length, of: n, p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: pct(lat, 1) },
    pingDuringLoadMs: { p50: pct(probes, 0.5), p95: pct(probes, 0.95), max: pct(probes, 1) },
  }));
  req.destroy(); srv.kill();
})().catch((e) => { console.error("bench error", e); try { srv.kill(); } catch {} process.exit(2); });
