// Preloaded with `node --require` into the BASELINE server: emulates the `claude` CLI so delivery paths can be run end to end.
"use strict";
const cp = require("child_process");
const fs = require("fs");
const LOG = process.env.STUB_LOG, SID = process.env.STUB_SID;
let busyUntil = 0;
const orig = cp.execFile;
cp.execFile = function (file, args, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  if (/claude(\.exe)?$/i.test(String(file))) {
    const a = args || [];
    fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), args: a.map((x) => String(x).slice(0, 60)) }) + "\n");
    let out = "";
    if (a[0] === "agents") out = JSON.stringify([{ id: "0a1b2c3d", sessionId: SID, kind: "background", state: Date.now() < busyUntil ? "working" : "idle", status: "idle", pid: 4242, name: "stub", cwd: process.env.USERPROFILE, startedAt: Date.now() - 1e6 }]);
    else if (a[0] === "stop") out = "stopped";
    else if (a.includes("--resume")) { busyUntil = Date.now() + 8000; out = "Starting background session\nbackgrounded · 0a1b2c3d"; }
    setImmediate(() => cb && cb(null, out, ""));
    return { on() {}, kill() {} };
  }
  return orig.apply(this, arguments);
};
