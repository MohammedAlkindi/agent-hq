// Test fixture. Preloaded with `node --require` into a dashboard process, it replaces the `claude` CLI with a
// scripted stand-in, so delivery paths can be tested end to end without a model, a login or a real session.
//   STUB_LOG   file that receives one JSON line per CLI call: { t, args }
//   STUB_SID   session id of the one fake background agent the stand-in reports
// The agent reports "working" for 8 seconds after a `--resume`, and "idle" otherwise.
"use strict";
const cp = require("child_process");
const fs = require("fs");

const LOG = process.env.STUB_LOG;
const SID = process.env.STUB_SID;
let busyUntil = 0;
const orig = cp.execFile;

cp.execFile = function (file, args, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  if (/claude(\.exe)?$/i.test(String(file))) {
    const a = args || [];
    if (LOG) fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), args: a.map((x) => String(x).slice(0, 80)) }) + "\n");
    let out = "";
    if (a[0] === "agents") {
      out = JSON.stringify([{ id: "0a1b2c3d", sessionId: SID, kind: "background", state: Date.now() < busyUntil ? "working" : "idle",
        status: "idle", pid: 4242, name: "stub", cwd: process.env.USERPROFILE, startedAt: Date.now() - 1e6 }]);
    } else if (a[0] === "stop") out = "stopped";
    else if (a.includes("--resume")) { busyUntil = Date.now() + 8000; out = "Starting background session\nbackgrounded · 0a1b2c3d"; }
    setImmediate(() => cb && cb(null, out, ""));
    return { on() {}, kill() {} };
  }
  return orig.apply(this, arguments);
};
