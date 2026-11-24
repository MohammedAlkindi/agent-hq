// Reproduces two suspected worktrees.js defects against the baseline clone, using a fake HOME
// and throwaway repos under the scratchpad. Usage: node repro-worktrees.js <scratchRoot>
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const root = process.argv[2];
const stamp = Date.now().toString(36);
const work = path.join(root, "wt-repro-" + stamp);
fs.mkdirSync(work, { recursive: true });
process.env.USERPROFILE = path.join(work, "home");
process.env.HOME = process.env.USERPROFILE;
fs.mkdirSync(process.env.USERPROFILE, { recursive: true });
const wt = require(path.join(root, "baseline", "agent-hq", "worktrees.js"));

const G = (args, cwd) => cp.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

function mkRepo(name) {
  const r = path.join(work, name);
  fs.mkdirSync(r, { recursive: true });
  G(["init", "-q", "-b", "main"], r);
  G(["config", "user.name", "t"], r); G(["config", "user.email", "t@t"], r); G(["config", "core.autocrlf", "false"], r);
  w(path.join(r, "package.json"), JSON.stringify({ name, scripts: { test: "node test.js" } }));
  return r;
}

(async () => {
  // ---------- R1: prune deletes a branch holding an unmerged commit ----------
  const r1 = mkRepo("r1");
  w(path.join(r1, "a.js"), "module.exports = 1;\n"); w(path.join(r1, "test.js"), "process.exit(0)\n");
  G(["add", "."], r1); G(["commit", "-q", "-m", "init"], r1);
  const c = await wt.createWorktree({ repo: r1, sid: "agent_r1" });
  w(path.join(c.path, "important.js"), "// 3 hours of agent work, committed but not merged\n");
  G(["add", "."], c.path); G(["commit", "-q", "-m", "agent work"], c.path);
  const old = new Date(Date.now() - 72 * 3600 * 1000);
  fs.utimesSync(c.path, old, old); // dir mtime does not change when nested files change; emulate an idle top dir
  const head = G(["rev-parse", "agent/agent_r1"], r1);
  const before = G(["branch", "--list", "agent/agent_r1"], r1);
  const res = await wt.pruneInactiveWorktrees({ maxAgeHours: 48 });
  const after = G(["branch", "--list", "agent/agent_r1"], r1);
  let reachable = "n/a";
  try { reachable = G(["cat-file", "-t", head], r1); } catch { reachable = "object gone"; }
  console.log("R1 prune result:", JSON.stringify(res.pruned.map((x) => ({ name: x.name, reason: x.reason }))));
  console.log("R1 branch before:", JSON.stringify(before), "after:", JSON.stringify(after));
  console.log("R1 unmerged commit object still in repo (reflog/gc-able only):", reachable);
  console.log("R1 worktree dir still exists:", fs.existsSync(c.path));

  // ---------- R2: 'speculative tests' pass on the branch, merge lands, main is broken ----------
  const r2 = mkRepo("r2");
  w(path.join(r2, "lib.js"), "exports.f = (a) => a * 2;\n");
  w(path.join(r2, "caller1.js"), "const {f} = require('./lib'); exports.run = () => f(2);\n");
  w(path.join(r2, "test.js"), "const {f}=require('./lib'); const c1=require('./caller1'); let ok = c1.run()===4;\ntry{ const c2=require('./caller2'); ok = ok && c2.run()===5; }catch(e){}\nprocess.exit(ok?0:1)\n");
  G(["add", "."], r2); G(["commit", "-q", "-m", "init"], r2);
  const a = await wt.createWorktree({ repo: r2, sid: "agent_A" });
  // Agent A: changes signature f(a) -> f(a, b) and updates the only caller it can see
  w(path.join(a.path, "lib.js"), "exports.f = (a, b) => a * 2 + b;\n");
  w(path.join(a.path, "caller1.js"), "const {f} = require('./lib'); exports.run = () => f(2, 0);\n");
  G(["add", "."], a.path); G(["commit", "-q", "-m", "A: f takes b"], a.path);
  // Meanwhile main (agent B landed first) adds a new caller using the OLD signature, different file
  w(path.join(r2, "caller2.js"), "const {f} = require('./lib'); exports.run = () => f(2) + 1;\n");
  w(path.join(r2, "test.js"), "const {f}=require('./lib'); const c1=require('./caller1'); const c2=require('./caller2');\nlet ok = c1.run()===4 && c2.run()===5;\nprocess.exit(ok?0:1)\n");
  G(["add", "."], r2); G(["commit", "-q", "-m", "B: new caller + test of both callers"], r2);
  const mr = await wt.mergeWorktree({ repo: r2, path: a.path, branch: "agent/agent_A", runTests: true, target: "main" });
  console.log("R2 mergeWorktree(runTests:true) ->", JSON.stringify({ ok: mr.ok, blocked: !!mr.blocked, msg: mr.msg }));
  let mainTests = "n/a";
  try { cp.execFileSync("node", ["test.js"], { cwd: r2, stdio: "pipe" }); mainTests = "PASS"; } catch (e) { mainTests = "FAIL (exit " + e.status + ")"; }
  console.log("R2 tests on main AFTER the merge landed:", mainTests);
  console.log("R2 git conflicts reported by merge: none (merge ok =", mr.ok + ")");
})().catch((e) => { console.error("script error", e); process.exit(2); });
