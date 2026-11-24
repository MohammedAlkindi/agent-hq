"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
if (process.argv[2] === "writer") {
  const files = JSON.parse(process.argv[3]); const n = +process.argv[4], gap = +process.argv[5];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => { for (let k = 0; k < n; k++) { for (const f of files) fs.appendFileSync(f, '{"k":' + k + "}\n"); if (gap) await sleep(gap); } })();
  return;
}
const root = path.join(process.argv[2], "watch2-" + Date.now().toString(36)); fs.mkdirSync(root, { recursive: true });
const N = 40, files = [];
for (let i = 0; i < N; i++) { const d = path.join(root, "p" + (i % 5)); fs.mkdirSync(d, { recursive: true }); const f = path.join(d, "s" + i + ".jsonl"); fs.writeFileSync(f, "{}\n"); files.push(f); }
const seen = new Set(); let total = 0;
const w = fs.watch(root, { recursive: true }, (ev, name) => { total++; if (name) seen.add(path.join(root, String(name))); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (const r of [{ name: "cross-process burst, 40 files x 25 appends, no delay", n: 25, gap: 0 }, { name: "cross-process steady, 40 files x 20 appends, 100 ms gap", n: 20, gap: 100 }]) {
    seen.clear(); total = 0;
    const t0 = Date.now();
    const c = cp.spawn(process.execPath, [__filename, "writer", JSON.stringify(files), String(r.n), String(r.gap)], { stdio: "inherit" });
    await new Promise((res) => c.on("exit", res));
    await sleep(1200);
    console.log(JSON.stringify({ round: r.name, appends: N * r.n, eventsReceived: total, filesWithAnyEvent: [...seen].filter((f) => files.includes(f)).length + "/" + N, seconds: +((Date.now() - t0) / 1000).toFixed(1) }));
  }
  w.close();
})();
