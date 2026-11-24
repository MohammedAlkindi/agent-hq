"use strict";

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const os = require("os");

const crypto = require("crypto");

const HOME = os.homedir();
// AGENT_HQ_WORKTREES points the whole module at another folder, so tests never touch the real ~/worktrees.
const WORKTREE_DIR = process.env.AGENT_HQ_WORKTREES || path.join(HOME, "worktrees");
const LEGACY_WT_DIR = process.env.AGENT_HQ_WORKTREES ? path.join(WORKTREE_DIR, ".no-legacy-dir") : path.join(HOME, "wt");

function normP(p) {
  return String(p || "").replace(/\\/g, "/");
}

function short(p) {
  const s = normP(p);
  const hn = normP(HOME).toLowerCase();
  return s.toLowerCase().startsWith(hn) ? "~" + s.slice(hn.length) : s;
}

function gitExec(args, cwd, timeout = 30000) {
  return new Promise((resolve) => {
    cp.execFile(
      "git",
      args,
      { cwd: cwd || HOME, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? err.code : 0,
          out: String(stdout || ""),
          err: String(stderr || (err ? err.message : "")),
        });
      }
    );
  });
}

async function findRepoRoot(targetPath) {
  const res = await gitExec(["rev-parse", "--show-toplevel"], targetPath);
  return res.ok ? res.out.trim() : null;
}

async function getBranchName(targetPath) {
  const res = await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], targetPath);
  return res.ok ? res.out.trim() : "";
}

// ---------------------------------------------------------------- safety helpers
// One merge, cleanup or branch change at a time per repository, in this process. Two overlapping merges used to
// race on the same checkout and index.
const repoLocks = new Map();
async function withRepoLock(root, fn) {
  const key = normP(root).toLowerCase();
  const prev = repoLocks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chained = prev.then(() => mine);
  repoLocks.set(key, chained);
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (repoLocks.get(key) === chained) repoLocks.delete(key);
  }
}

const branchExists = async (root, ref) => (await gitExec(["rev-parse", "--verify", "--quiet", ref + "^{commit}"], root)).ok;
// true when every commit of `branch` is already in `target`
const isAncestor = async (root, branch, target) => (await gitExec(["merge-base", "--is-ancestor", branch, target], root)).ok;
async function countUnmerged(root, branch, target) {
  const r = await gitExec(["rev-list", "--count", `${target}..${branch}`], root);
  return r.ok ? parseInt(r.out.trim(), 10) || 0 : -1; // -1: could not tell, treated as "unmerged work may exist"
}
// tracked files modified, staged or deleted (untracked files do not block a merge or a worktree move)
async function hasTrackedChanges(dir) {
  const r = await gitExec(["status", "--porcelain", "--untracked-files=no"], dir, 15000);
  return !r.ok || r.out.trim().length > 0; // a failed status counts as "not safe to assume clean"
}
async function hasAnyChanges(dir) {
  const r = await gitExec(["status", "--porcelain"], dir, 15000);
  return !r.ok || r.out.trim().length > 0;
}
async function mergeInProgress(root) {
  return (await gitExec(["rev-parse", "-q", "--verify", "MERGE_HEAD"], root)).ok;
}
async function defaultBranch(root) {
  for (const b of ["main", "master"]) if (await branchExists(root, b)) return b;
  return await getBranchName(root);
}
function repoRootOfWorktree(dir) {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, ".git"), "utf8").trim());
    const wt = m && /^(.*?)[\\/]\.git[\\/]worktrees/i.exec(m[1].trim());
    return wt ? wt[1] : "";
  } catch { return ""; }
}
const sameFile = (a, b) => normP(a).toLowerCase().replace(/\/+$/, "") === normP(b).toLowerCase().replace(/\/+$/, "");
const isInside = (child, parent) => {
  const c = normP(child).toLowerCase().replace(/\/+$/, ""), p = normP(parent).toLowerCase().replace(/\/+$/, "");
  return c === p || c.startsWith(p + "/");
};
// Last sign of life: the newest of the directory mtime (which does NOT change when a file inside a subfolder
// is edited, so it cannot be used alone), the branch's last commit, the index and the HEAD reflog.
async function lastActivity(wtPath) {
  let t = 0;
  const stat = (p) => { try { t = Math.max(t, fs.statSync(p).mtimeMs); } catch {} };
  stat(wtPath);
  const gd = await gitExec(["rev-parse", "--absolute-git-dir"], wtPath, 10000);
  if (gd.ok) {
    const dir = gd.out.trim();
    stat(path.join(dir, "index")); stat(path.join(dir, "HEAD")); stat(path.join(dir, "logs", "HEAD"));
  }
  const lc = await gitExec(["log", "-1", "--format=%ct"], wtPath, 10000);
  if (lc.ok && lc.out.trim()) t = Math.max(t, parseInt(lc.out.trim(), 10) * 1000 || 0);
  return t;
}

async function listWorktrees(repoFilter) {
  const results = [];
  const dirsToScan = [WORKTREE_DIR, LEGACY_WT_DIR];

  for (const parent of dirsToScan) {
    if (!fs.existsSync(parent)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const fullPath = path.join(parent, ent.name);
      const gitFile = path.join(fullPath, ".git");
      const isWorktree = fs.existsSync(gitFile);

      let branch = "";
      let repoRoot = "";
      let modified = 0;
      let age = 0;

      try {
        const st = fs.statSync(fullPath);
        age = Date.now() - st.mtimeMs;
      } catch {}

      if (isWorktree) {
        try {
          const content = fs.readFileSync(gitFile, "utf8").trim();
          const m = /^gitdir:\s*(.+)$/m.exec(content);
          if (m) {
            const gitDir = m[1].trim();
            // Gitdir is usually in <repoRoot>/.git/worktrees/<name>
            const wtMatch = /^(.*?)[\\/]\.git[\\/]worktrees/i.exec(gitDir);
            if (wtMatch) repoRoot = wtMatch[1];
          }
        } catch {}

        const bRes = await getBranchName(fullPath);
        branch = bRes || "";

        const sRes = await gitExec(["status", "--porcelain"], fullPath, 5000);
        if (sRes.ok && sRes.out.trim()) {
          modified = sRes.out.trim().split("\n").filter(Boolean).length;
        }
      }

      if (repoFilter && repoRoot && normP(repoRoot).toLowerCase() !== normP(repoFilter).toLowerCase()) {
        continue;
      }

      results.push({
        name: ent.name,
        path: fullPath,
        displayPath: short(fullPath),
        isWorktree,
        repo: repoRoot,
        displayRepo: repoRoot ? short(repoRoot) : "",
        branch,
        modified,
        age,
      });
    }
  }

  return results.sort((a, b) => a.age - b.age);
}

async function createWorktree({ repo, sid, name, branch, startPoint }) {
  if (!repo || !fs.existsSync(repo)) {
    return { ok: false, msg: `Repository path does not exist: ${repo}` };
  }
  const root = await findRepoRoot(repo);
  if (!root) {
    return { ok: false, msg: `Not a git repository: ${repo}` };
  }

  // A session id keeps one stable folder. A name taken from a prompt does not: two prompts that begin with the
  // same six words (or two repositories) used to be handed the same folder and branch, which is not isolation.
  const base = String(sid || name || "agent").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "agent";
  const id = sid ? base : `${base}-${crypto.randomBytes(3).toString("hex")}`;
  const targetDir = path.join(WORKTREE_DIR, id);
  const branchName = branch || `agent/${id}`;

  if (fs.existsSync(targetDir)) {
    const owner = repoRootOfWorktree(targetDir);
    if (owner && sameFile(owner, root)) {
      return {
        ok: true, reused: true, path: targetDir, displayPath: short(targetDir), repo: root, sid: id,
        branch: (await getBranchName(targetDir)) || branchName,
        msg: `Worktree already exists: ${short(targetDir)}`,
      };
    }
    return { ok: false, msg: `${short(targetDir)} already exists and is not a worktree of ${short(root)}. Choose another name.` };
  }

  try {
    fs.mkdirSync(WORKTREE_DIR, { recursive: true });
  } catch {}

  return withRepoLock(root, async () => {
    const existing = await branchExists(root, branchName);
    // The new branch starts at an explicit commit (default: the checkout's current HEAD), never an implicit one.
    const start = startPoint || "HEAD";
    let addRes;
    // Parallel `git worktree add` calls race on .git/config.lock; retry a few times with jitter.
    for (let attempt = 0; attempt < 4; attempt++) {
      addRes = existing
        ? await gitExec(["worktree", "add", targetDir, branchName], root)
        : await gitExec(["worktree", "add", "-b", branchName, targetDir, start], root);
      if (addRes.ok || !/could not lock config file|\.lock/i.test(addRes.err)) break;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1) + Math.random() * 200));
    }
    if (!addRes.ok) {
      return { ok: false, msg: `git worktree add failed: ${addRes.err || addRes.out}` };
    }
    return {
      ok: true,
      path: targetDir,
      displayPath: short(targetDir),
      branch: branchName,
      repo: root,
      sid: id,
      msg: `Isolated worktree created at ${short(targetDir)} on branch "${branchName}"`,
    };
  });
}

async function runSpeculativeTests({ repo, path: wtPath, branch, command, timeout = 60000 }) {
  let cwd = wtPath;
  if (!cwd && repo) cwd = repo;
  if (!cwd || !fs.existsSync(cwd)) {
    return {
      ok: false,
      passed: false,
      code: 1,
      out: "",
      err: `Target directory not found: ${cwd || "(empty)"}`,
      msg: `Target directory not found: ${cwd || "(empty)"}`,
    };
  }

  let cmd = command;
  if (!cmd) {
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.scripts && pkg.scripts.test) {
          cmd = "npm test";
        }
      } catch {}
    }
    if (!cmd && fs.existsSync(path.join(cwd, "run-tests.js"))) {
      cmd = "node run-tests.js";
    }
    if (!cmd) {
      cmd = "npm test";
    }
  }

  return new Promise((resolve) => {
    cp.exec(cmd, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || "");
      const errOut = String(stderr || (err ? err.message : ""));
      const code = err ? (err.code || 1) : 0;
      const passed = !err;
      resolve({
        ok: passed,
        passed,
        code,
        command: cmd,
        cwd,
        out,
        err: errOut,
        msg: passed ? `Speculative pre-flight tests passed: ${cmd}` : `Speculative pre-flight tests failed (${code}): ${cmd}`,
      });
    });
  });
}

// Runs the project's tests on the tree the merge WILL produce, in a throwaway detached worktree at the target
// tip. Testing the branch alone cannot catch a semantic conflict (for example the branch changes a function
// signature while the target gained a new caller): both sides are green, the merge is clean, the result is broken.
async function testMergedTree(root, branch, target, command, timeout) {
  const tmp = path.join(WORKTREE_DIR, ".landing", crypto.randomBytes(4).toString("hex"));
  try { fs.mkdirSync(path.dirname(tmp), { recursive: true }); } catch {}
  const add = await gitExec(["worktree", "add", "--detach", tmp, target], root);
  if (!add.ok) return { ok: false, stage: "setup", msg: `Could not prepare a scratch worktree for the merge test: ${add.err || add.out}` };
  try {
    const merged = await gitExec(["merge", "--no-ff", "--no-edit", branch], tmp);
    if (!merged.ok) {
      const files = (await gitExec(["diff", "--name-only", "--diff-filter=U"], tmp)).out.split("\n").map((s) => s.trim()).filter(Boolean);
      await gitExec(["merge", "--abort"], tmp);
      return { ok: false, stage: "conflict", files, msg: `"${branch}" conflicts with "${target}"${files.length ? ` in ${files.slice(0, 5).join(", ")}` : ""}.` };
    }
    const tree = (await gitExec(["rev-parse", "HEAD^{tree}"], tmp)).out.trim();
    const test = await runSpeculativeTests({ repo: root, path: tmp, branch, command, timeout });
    return { ok: test.passed, stage: "tests", tree, test };
  } finally {
    await gitExec(["worktree", "remove", "--force", tmp], root); // our own scratch folder, nothing of the user's
    await gitExec(["worktree", "prune"], root);
  }
}

async function mergeWorktree({ repo, path: wtPath, branch, target = "main", message, runTests = false, force = false, testCommand, testTimeout, cleanup = true, deleteBranch = true, protect = [] }) {
  let root = repo;
  if (!root && wtPath) root = await findRepoRoot(wtPath);
  if (!root) return { ok: false, msg: "Repository root could not be determined." };

  const branchToMerge = branch || (wtPath ? await getBranchName(wtPath) : "");
  if (!branchToMerge || branchToMerge === "HEAD") return { ok: false, msg: "Branch name is required to merge." };
  if (branchToMerge === target) return { ok: false, msg: `"${branchToMerge}" is the target branch; nothing to merge.` };

  return withRepoLock(root, async () => {
    if (!(await branchExists(root, branchToMerge))) return { ok: false, msg: `Branch "${branchToMerge}" does not exist in the repository.` };
    if (!(await branchExists(root, target))) return { ok: false, msg: `Target branch "${target}" does not exist in repository.` };

    // The merge happens in the user's own checkout, so that checkout has to be exactly where the merge is meant
    // to land. It used to merge into whatever branch happened to be checked out, and to leave a half-finished merge
    // behind on a conflict.
    const current = await getBranchName(root);
    if (current !== target) {
      return { ok: false, wrongBranch: true, msg: `The checkout at ${short(root)} is on ${current && current !== "HEAD" ? `"${current}"` : "a detached HEAD"}, not "${target}". Nothing was merged. Check out "${target}" and try again.` };
    }
    if (await mergeInProgress(root)) return { ok: false, msg: `A merge is already in progress in ${short(root)}. Finish or abort it first.` };
    if (await hasTrackedChanges(root)) return { ok: false, dirty: true, msg: `The checkout at ${short(root)} has uncommitted changes to tracked files. Commit or stash them first; nothing was merged.` };

    // Optional: run the tests on the merge result (not on the branch alone) before landing it.
    let testedTree = "";
    if (runTests) {
      const t = await testMergedTree(root, branchToMerge, target, testCommand, testTimeout);
      if (t.stage === "conflict") return { ok: false, conflict: true, files: t.files, msg: `${t.msg} Nothing was merged.` };
      if (!t.ok && !force) {
        const detail = t.test ? (t.test.err || t.test.out || "").trim().split("\n").slice(-6).join("\n") : t.msg;
        return {
          ok: false,
          blocked: true,
          testsFailed: t.stage === "tests",
          testResult: t.test,
          msg: `The tests fail on the merged result of "${branchToMerge}" and "${target}". Nothing was merged (use force: true to override): ${detail}`,
        };
      }
      testedTree = t.tree || "";
    }

    const commitMsg = message || `Merge worktree branch ${branchToMerge} into ${target}`;
    const mergeRes = await gitExec(["merge", "--no-ff", branchToMerge, "-m", commitMsg], root);
    if (!mergeRes.ok) {
      const files = (await gitExec(["diff", "--name-only", "--diff-filter=U"], root)).out.split("\n").map((s) => s.trim()).filter(Boolean);
      await gitExec(["merge", "--abort"], root); // leave the user's checkout as it was
      return { ok: false, conflict: files.length > 0, files, msg: `Merge failed and was rolled back: ${(mergeRes.err || mergeRes.out).trim().split("\n")[0]}` };
    }
    const mergedTree = (await gitExec(["rev-parse", "HEAD^{tree}"], root)).out.trim();

    let cleanedUp = false;
    let branchDeleted = false;
    const notes = [];
    if (cleanup && wtPath && !sameFile(wtPath, root)) {
      if (protect.some((p) => p && isInside(p, wtPath))) {
        notes.push("worktree kept: a session is still working in it");
      } else if (await hasAnyChanges(wtPath)) {
        notes.push("worktree kept: it has uncommitted or untracked files");
      } else {
        const c = await cleanupWorktree({ repo: root, path: wtPath, branch: deleteBranch ? branchToMerge : null });
        cleanedUp = !!c.removed;
        branchDeleted = !!c.branchDeleted;
        if (!c.ok) notes.push(c.msg);
        else if (c.branchKept) notes.push(...c.notes);
      }
    } else if (deleteBranch) {
      // branch -d only deletes a branch that is fully merged, which it is now
      branchDeleted = (await gitExec(["branch", "-d", branchToMerge], root)).ok;
    }
    await gitExec(["worktree", "prune"], root);

    return {
      ok: true,
      msg: `Merged "${branchToMerge}" into "${target}" successfully.` + (cleanedUp ? " Removed the worktree." : "") + (branchDeleted ? " Deleted the branch." : "") + (notes.length ? ` (${notes.join("; ")})` : ""),
      out: mergeRes.out.trim(),
      cleanedUp,
      branchDeleted,
      testedMergedTree: runTests ? testedTree !== "" && testedTree === mergedTree : null,
    };
  });
}

// Removes a worktree and, optionally, its branch. It never deletes files git did not ask to delete, and it only
// force-deletes a branch when the caller says deleteUnmerged: true. (It used to fall back to rm -rf on the folder
// and to `branch -D`, which threw away uncommitted files and unmerged commits.)
async function cleanupWorktree({ repo, path: wtPath, branch, force = false, deleteUnmerged = false, protect = [] }) {
  if (!wtPath) return { ok: false, msg: "A worktree path is required." };
  if (protect.some((p) => p && isInside(p, wtPath))) return { ok: false, msg: `A session is still working in ${short(wtPath)}; it was not removed.` };
  let root = repo || (fs.existsSync(wtPath) ? repoRootOfWorktree(wtPath) : "");
  if (!root && fs.existsSync(wtPath)) root = await findRepoRoot(wtPath);

  const out = { ok: true, removed: false, branchDeleted: false, branchKept: false, notes: [] };

  if (fs.existsSync(wtPath)) {
    if (!root) return { ok: false, msg: `${short(wtPath)} is not a worktree of a known repository; refusing to delete it.` };
    if (!force && (await hasAnyChanges(wtPath))) {
      return { ok: false, msg: `${short(wtPath)} has uncommitted or untracked files; nothing was removed. Commit or discard them, or pass force.` };
    }
    const args = ["worktree", "remove", wtPath];
    if (force) args.push("--force");
    const rm = await gitExec(args, root);
    if (!rm.ok) return { ok: false, msg: `git could not remove ${short(wtPath)}: ${(rm.err || rm.out).trim().split("\n")[0]}` };
    out.removed = true;
  }

  if (root && branch) {
    const del = await gitExec(["branch", deleteUnmerged ? "-D" : "-d", branch], root);
    if (del.ok) out.branchDeleted = true;
    else {
      out.branchKept = true;
      out.notes.push(`branch "${branch}" kept: ${(del.err || del.out).trim().split("\n")[0]}`);
    }
  }

  if (root) await gitExec(["worktree", "prune"], root);
  out.msg = `Worktree ${short(wtPath)} ${out.removed ? "removed" : "was already gone"}.` + (out.branchDeleted ? " Branch deleted." : "") + (out.notes.length ? ` ${out.notes.join(" ")}` : "");
  return out;
}

async function getDiffForSession(session, allStates) {
  if (!session) return { ok: false, msg: "Session not found." };

  let candidateDirs = [session.cwd, session.room].filter(Boolean);
  if (allStates) {
    const st = allStates.get(session.id);
    if (st && st.cwd) candidateDirs.unshift(st.cwd);
  }

  // Also check if ~/worktrees/<sid> exists
  if (session.id) {
    const candidateWorktree = path.join(WORKTREE_DIR, String(session.id));
    if (fs.existsSync(candidateWorktree)) {
      candidateDirs.unshift(candidateWorktree);
    }
  }

  let validRoot = null;
  let workDir = null;

  for (const d of candidateDirs) {
    if (!d || !fs.existsSync(d)) continue;
    const r = await findRepoRoot(d);
    if (r) {
      validRoot = r;
      workDir = d;
      break;
    }
  }

  if (!workDir || !validRoot) {
    return {
      ok: true,
      sid: session.id,
      diff: "",
      files: [],
      msg: "No git repository found for this session.",
    };
  }

  const branch = await getBranchName(workDir);

  // Status for untracked / modified files
  const statusRes = await gitExec(["status", "--porcelain"], workDir);
  const statusFiles = [];
  if (statusRes.ok) {
    for (const line of statusRes.out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const code = trimmed.slice(0, 2).trim();
      const file = trimmed.slice(2).trim();
      statusFiles.push({ file, status: code, add: 0, del: 0 });
    }
  }

  // Full diff of unstaged and staged changes
  const diffRes = await gitExec(["diff", "HEAD"], workDir);
  let diffText = diffRes.ok ? diffRes.out : "";

  // If working tree is clean but session is on an agent branch, diff against main
  if (!diffText.trim() && branch && branch !== "main" && branch !== "master" && branch !== "HEAD") {
    const branchDiff = await gitExec(["diff", "main...HEAD"], workDir);
    if (branchDiff.ok && branchDiff.out.trim()) {
      diffText = branchDiff.out;
    }
  }

  // Parse diff stats per file
  let totalAdd = 0;
  let totalDel = 0;
  const numstatRes = await gitExec(["diff", "--numstat", "HEAD"], workDir);
  if (numstatRes.ok && numstatRes.out.trim()) {
    for (const line of numstatRes.out.split("\n")) {
      const parts = line.split("\t");
      if (parts.length >= 3) {
        const a = parseInt(parts[0], 10) || 0;
        const d = parseInt(parts[1], 10) || 0;
        const f = parts[2].trim();
        totalAdd += a;
        totalDel += d;
        const existing = statusFiles.find((x) => x.file === f);
        if (existing) {
          existing.add = a;
          existing.del = d;
        } else {
          statusFiles.push({ file: f, status: "M", add: a, del: d });
        }
      }
    }
  }

  return {
    ok: true,
    sid: session.id,
    repo: short(validRoot),
    worktree: short(workDir),
    branch,
    diff: diffText,
    files: statusFiles,
    stats: {
      filesChanged: statusFiles.length,
      additions: totalAdd,
      deletions: totalDel,
    },
    msg: diffText ? "Diff loaded." : "Working tree clean.",
  };
}

// Removes worktrees nobody is using. The rules, in order:
//  - never a worktree a live session is working in (`protect` holds those folders; the server fills it in);
//  - never one with uncommitted or untracked files unless force: true;
//  - never one on the default branch or a detached HEAD;
//  - "unused" means the branch is fully merged into the default branch, or nothing happened in it for maxAgeHours,
//    measured by the newest of the folder, the index, the HEAD reflog and the last commit (the folder's own mtime
//    does not move when a file in a subfolder changes);
//  - the branch is deleted only when it is fully merged. An idle worktree whose branch holds unmerged commits is
//    removed from disk but its branch is KEPT, so no work is lost (deleteUnmerged: true overrides, explicitly).
async function pruneInactiveWorktrees({ maxAgeHours = 48, force = false, repoFilter, protect = [], dryRun = false, deleteUnmerged = false } = {}) {
  const all = await listWorktrees(repoFilter);
  const maxAgeMs = maxAgeHours * 3600 * 1000;
  const pruned = [];
  const skipped = [];

  for (const wt of all) {
    const skip = (reason) => skipped.push({ path: wt.path, name: wt.name, reason });
    if (!wt.isWorktree || !wt.repo) { skip("not a git worktree"); continue; }
    if (protect.some((p) => p && isInside(p, wt.path))) { skip("a live session is working here"); continue; }
    if (wt.modified > 0 && !force) { skip(`${wt.modified} uncommitted or untracked files`); continue; }

    const target = await defaultBranch(wt.repo);
    if (!wt.branch || wt.branch === "HEAD") { skip("detached HEAD"); continue; }
    if (wt.branch === "main" || wt.branch === "master" || wt.branch === target) { skip("default branch"); continue; }

    const unmerged = await countUnmerged(wt.repo, wt.branch, target);
    const merged = unmerged === 0;
    const idleMs = Date.now() - (await lastActivity(wt.path));
    const idleH = (idleMs / 3600000).toFixed(1);
    if (!merged && idleMs < maxAgeMs) { skip(`active (idle ${idleH} h)`); continue; }

    const keepBranch = !merged && !deleteUnmerged;
    const reason = merged ? "branch merged" : `idle ${idleH} h (branch kept: ${unmerged < 0 ? "unmerged work not ruled out" : unmerged + " unmerged commit" + (unmerged === 1 ? "" : "s")})`;
    if (dryRun) { pruned.push({ path: wt.path, name: wt.name, branch: wt.branch, reason, dryRun: true }); continue; }

    const r = await cleanupWorktree({ repo: wt.repo, path: wt.path, branch: keepBranch ? null : wt.branch, force: wt.modified > 0 && force, deleteUnmerged });
    if (r.ok) pruned.push({ path: wt.path, name: wt.name, branch: wt.branch, reason, branchKept: keepBranch || r.branchKept });
    else skip(r.msg);
  }

  // Final prune pass across repositories
  const touchedRepos = new Set(all.map((w) => w.repo).filter(Boolean));
  for (const r of touchedRepos) {
    await gitExec(["worktree", "prune"], r);
  }

  return { ok: true, pruned, skipped };
}

module.exports = {
  WORKTREE_DIR,
  LEGACY_WT_DIR,
  short,
  gitExec,
  findRepoRoot,
  listWorktrees,
  createWorktree,
  mergeWorktree,
  cleanupWorktree,
  pruneInactiveWorktrees,
  getDiffForSession,
  runSpeculativeTests,
};
