// Verifies that Claude Code HTTP hooks reach a local server on this Windows box and records event order, fields and latency.
// Uses a throwaway settings file passed with --settings and --setting-sources "" so the user's own hooks and settings are not touched.
"use strict";
const fs = require("fs"), path = require("path"), http = require("http"), cp = require("child_process"), os = require("os");
const root = process.argv[2], PORT = 7841;
const work = path.join(root, "hook-http-" + Date.now().toString(36)); fs.mkdirSync(work, { recursive: true });
const events = []; const t0 = Date.now();
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => b += c);
  req.on("end", () => {
    let j = {}; try { j = JSON.parse(b); } catch {}
    events.push({ t: Date.now() - t0, ev: j.hook_event_name, keys: Object.keys(j).sort(), tool: j.tool_name || "", ntype: j.notification_type || "", ctype: req.headers["content-type"], ua: String(req.headers["user-agent"] || "").slice(0, 40) });
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
  });
}).listen(PORT, "127.0.0.1");
const hook = (m) => [{ ...(m ? { matcher: m } : {}), hooks: [{ type: "http", url: `http://127.0.0.1:${PORT}/hook`, timeout: 10 }] }];
const settings = { hooks: { SessionStart: hook(), UserPromptSubmit: hook(), PreToolUse: hook("*"), PostToolUse: hook("*"), PostToolUseFailure: hook("*"), PermissionRequest: hook("*"), Notification: hook(), Stop: hook(), SessionEnd: hook() } };
const sf = path.join(work, "settings.json"); fs.writeFileSync(sf, JSON.stringify(settings));
const claude = [path.join(os.homedir(), ".local", "bin", "claude.exe")].find((p) => fs.existsSync(p)) || "claude";
const args = ["-p", "Use the Bash tool to run exactly: echo hookprobe. Then reply with the single word done.", "--model", "haiku", "--settings", sf, "--setting-sources", "", "--allowedTools", "Bash", "--max-turns", "4", "--output-format", "json", "--no-session-persistence"];
const start = Date.now();
cp.execFile(claude, args, { cwd: work, timeout: 120000, windowsHide: true, maxBuffer: 8e6 }, (err, stdout, stderr) => {
  const dur = Date.now() - start;
  setTimeout(() => {
    let cost = null, result = ""; try { const j = JSON.parse(stdout); cost = j.total_cost_usd; result = String(j.result || "").slice(0, 40); } catch {}
    console.log(JSON.stringify({ exitError: err ? String(err.message).slice(0, 120) : null, durationMs: dur, costUsd: cost, result, eventCount: events.length }, null, 1));
    const seen = {}; for (const e of events) { seen[e.ev] = (seen[e.ev] || 0) + 1; }
    console.log("events by type:", JSON.stringify(seen));
    console.log("timeline (ms since launch):", events.map((e) => `${e.t}:${e.ev}${e.tool ? "(" + e.tool + ")" : ""}`).join("  "));
    const firstOf = {}; for (const e of events) if (!firstOf[e.ev]) firstOf[e.ev] = e; for (const k of Object.keys(firstOf)) console.log(k + " keys:", firstOf[k].keys.join(","), "| content-type:", firstOf[k].ctype);
    const pre = events.find((e) => e.ev === "PreToolUse"), stop = events.find((e) => e.ev === "Stop");
    if (pre) console.log("PreToolUse keys:", pre.keys.join(","), "| content-type:", pre.ctype, "| ua:", pre.ua);
    if (stop) console.log("Stop keys:", stop.keys.join(","));
    srv.close(); process.exit(0);
  }, 1500);
});
