"use strict";

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const os = require("os");

const HOME = os.homedir();
const WORKTREE_DIR = path.join(HOME, "worktrees");
const LEGACY_WT_DIR = path.join(HOME, "wt");

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

async function createWorktree({ repo, sid, name, branch }) {
  if (!repo || !fs.existsSync(repo)) {
    return { ok: false, msg: `Repository path does not exist: ${repo}` };
  }
  const root = await findRepoRoot(repo);
  if (!root) {
    return { ok: false, msg: `Not a git repository: ${repo}` };
  }

  const id = String(sid || name || Date.now().toString(36)).replace(/[^a-zA-Z0-9_-]/g, "_");
  const targetDir = path.join(WORKTREE_DIR, id);
  const branchName = branch || `agent/${id}`;

  if (fs.existsSync(targetDir)) {
    return { ok: true, path: targetDir, branch: branchName, msg: `Worktree already exists: ${short(targetDir)}` };
  }

  try {
    fs.mkdirSync(WORKTREE_DIR, { recursive: true });
  } catch {}

  // Check if branch already exists in repo
  const checkBranch = await gitExec(["rev-parse", "--verify", branchName], root);
  let addRes;
  if (checkBranch.ok) {
    addRes = await gitExec(["worktree", "add", targetDir, branchName], root);
  } else {
    addRes = await gitExec(["worktree", "add", "-b", branchName, targetDir], root);
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
}

async function mergeWorktree({ repo, path: wtPath, branch, target = "main", message }) {
  let root = repo;
  if (!root && wtPath) root = await findRepoRoot(wtPath);
  if (!root) return { ok: false, msg: "Repository root could not be determined." };

  const branchToMerge = branch || (wtPath ? await getBranchName(wtPath) : "");
  if (!branchToMerge) return { ok: false, msg: "Branch name is required to merge." };

  // Check if target branch exists
  const checkTarget = await gitExec(["rev-parse", "--verify", target], root);
  if (!checkTarget.ok) {
    return { ok: false, msg: `Target branch "${target}" does not exist in repository.` };
  }

  const commitMsg = message || `Merge worktree branch ${branchToMerge} into ${target}`;
  const mergeRes = await gitExec(["merge", "--no-ff", branchToMerge, "-m", commitMsg], root);

  if (!mergeRes.ok) {
    return { ok: false, msg: `Merge failed: ${mergeRes.err || mergeRes.out}` };
  }

  return {
    ok: true,
    msg: `Merged "${branchToMerge}" into "${target}" successfully.`,
    out: mergeRes.out.trim(),
  };
}

async function cleanupWorktree({ repo, path: wtPath, branch, force = false }) {
  let root = repo;
  if (!root && wtPath) root = await findRepoRoot(wtPath);
  if (!root && wtPath) {
    const gitFile = path.join(wtPath, ".git");
    if (fs.existsSync(gitFile)) {
      try {
        const content = fs.readFileSync(gitFile, "utf8");
        const m = /^gitdir:\s*(.+)$/m.exec(content);
        if (m) {
          const wtMatch = /^(.*?)[\\/]\.git[\\/]worktrees/i.exec(m[1].trim());
          if (wtMatch) root = wtMatch[1];
        }
      } catch {}
    }
  }

  if (root && wtPath) {
    const args = ["worktree", "remove", wtPath];
    if (force) args.push("--force");
    await gitExec(args, root);
  }

  if (fs.existsSync(wtPath)) {
    try {
      fs.rmSync(wtPath, { recursive: true, force: true });
    } catch {}
  }

  if (root && branch) {
    const bArgs = ["branch", force ? "-D" : "-d", branch];
    await gitExec(bArgs, root);
  }

  if (root) {
    await gitExec(["worktree", "prune"], root);
  }

  return {
    ok: true,
    msg: `Worktree ${short(wtPath)} cleaned up successfully.`,
  };
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
  getDiffForSession,
};
