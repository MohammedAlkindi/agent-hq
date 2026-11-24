// End-to-end repro of the one-click "Accept & Send" double delivery against the BASELINE server with a stubbed claude CLI.
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), http = require("http");
const root = process.argv[2], port = 7830;
const home = path.join(root, "e2e-home-" + Date.now().toString(36));
const stateDir = path.join(home, "hqstate");
fs.mkdirSync(stateDir, { recursive: true });
const SID = "11111111-2222-3333-4444-555555555555", KEY = SID + ":1";
fs.writeFileSync(path.join(stateDir, "drafts.json"), JSON.stringify({ [KEY]: { key: KEY, id: SID, title: "stub", kind: "background", since: 1, at: Date.now(), reply: "Yes, go ahead with option B.", wouldSend: true } }));
const log = path.join(home, "stub.log");
const env = { ...process.env, USERPROFILE: home, HOME: home, AGENT_DASH_PORT: String(port), AGENT_HQ_STATE: stateDir, STUB_LOG: log, STUB_SID: SID };
const srv = cp.spawn(process.execPath, ["--require", path.join(root, "stub-claude-preload.js"), path.join(root, "baseline", "agent-hq", "agent-dashboard.js"), "--serve"], { env, stdio: "ignore", windowsHide: true });
const req = (method, p, body, headers = {}) => new Promise((res, rej) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } }, (x) => { let s = ""; x.on("data", (c) => s += c); x.on("end", () => res({ code: x.statusCode, body: s })); });
  r.on("error", rej); if (data) r.write(data); r.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await req("GET", "/api/ping")).code === 200) break; } catch {} await sleep(250); }
  await sleep(1500);
  const html = (await req("GET", "/")).body; const tok = /const TOKEN = "([0-9a-f]{20,})"/.exec(html)[1];
  const H = { "x-agents-token": tok };
  // Exactly what agents-ui/dispatch.js acceptAndSendDraft does for a background session:
  const r1 = await req("POST", "/api/dispatch/send", { sid: SID, key: KEY, reply: "Yes, go ahead with option B." }, H);
  console.log("step 1 POST /api/dispatch/send ->", r1.code, r1.body.slice(0, 120));
  let r2 = null;
  if (!JSON.parse(r1.body).ok) { r2 = await req("POST", "/api/prompt", { target: SID, text: "Yes, go ahead with option B." }, H); console.log("step 2 fallback POST /api/prompt ->", r2.code, r2.body.slice(0, 160)); }
  await sleep(16000); // let the 5 s queue drain run after the stub's 8 s busy period
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const resumes = calls.filter((c) => c.args.includes("--resume"));
  console.log("claude CLI invocations by kind:", JSON.stringify({ agents: calls.filter((c) => c.args[0] === "agents").length, stop: calls.filter((c) => c.args[0] === "stop").length, resume: resumes.length }));
  console.log("RESUME calls (each delivers the text to the agent):", resumes.length, resumes.map((c) => new Date(c.t).toISOString().slice(11, 19)).join(", "));
  const q = path.join(home, ".claude", "state", "agents-queue.json");
  console.log("queue file after drain:", fs.existsSync(q) ? fs.readFileSync(q, "utf8") : "(none)");
  srv.kill();
})().catch((e) => { console.error(e); try { srv.kill(); } catch {} process.exit(2); });
