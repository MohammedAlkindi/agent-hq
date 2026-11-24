// coordination.js - Multi-agent file locking, symbol claims & intent coordination
// Built on Node 24 node:sqlite DatabaseSync with WAL journal mode.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const STATE_DIR = process.env.AGENT_HQ_STATE_DIR || path.join(__dirname, ".state");
const DEFAULT_DB_PATH = path.join(STATE_DIR, "coordination.db");

let dbInstance = null;
let currentDbPath = DEFAULT_DB_PATH;

const normPath = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();

function initCoordination(customDbPath = null) {
  if (customDbPath) {
    if (dbInstance) {
      try { dbInstance.close(); } catch {}
      dbInstance = null;
    }
    currentDbPath = customDbPath;
  }

  if (dbInstance) return dbInstance;

  if (currentDbPath !== ":memory:") {
    const parentDir = path.dirname(currentDbPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
  }

  const db = new DatabaseSync(currentDbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  // 1. Agent Sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_id TEXT PRIMARY KEY,
      harness TEXT,
      worktree_path TEXT,
      branch TEXT,
      status TEXT DEFAULT 'active',
      heartbeat_at INTEGER,
      created_at INTEGER
    );
  `);

  // 2. File Leases (exclusive_write | shared_read, TTL 60s)
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_leases (
      lease_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      lease_type TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leases_file ON file_leases(file_path);
    CREATE INDEX IF NOT EXISTS idx_leases_session ON file_leases(session_id);
    CREATE INDEX IF NOT EXISTS idx_leases_expires ON file_leases(expires_at);
  `);

  // 3. Symbol Claims
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbol_claims (
      claim_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      symbol_name TEXT NOT NULL,
      symbol_type TEXT,
      intent_summary TEXT,
      claimed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claims_symbol ON symbol_claims(file_path, symbol_name);
  `);

  // 4. Intent Broadcasts
  db.exec(`
    CREATE TABLE IF NOT EXISTS intent_broadcasts (
      broadcast_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message TEXT NOT NULL,
      affected_files TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_broadcast_created ON intent_broadcasts(created_at);
  `);

  dbInstance = db;
  return dbInstance;
}

function getDb() {
  if (!dbInstance) initCoordination();
  return dbInstance;
}

function reapStaleLeases() {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare("DELETE FROM file_leases WHERE expires_at < ?");
  const result = stmt.run(now);
  return { ok: true, reapedCount: result.changes || 0 };
}

function checkContention(filePath, excludeSessionId = null) {
  reapStaleLeases();
  const db = getDb();
  const np = normPath(filePath);

  let query = "SELECT * FROM file_leases WHERE file_path = ?";
  const params = [np];
  if (excludeSessionId) {
    query += " AND session_id != ?";
    params.push(excludeSessionId);
  }

  const rows = db.prepare(query).all(...params);
  const writeLease = rows.find((r) => r.lease_type === "exclusive_write");

  return {
    hasContention: rows.length > 0,
    hasWriteContention: !!writeLease,
    blockingLease: writeLease || rows[0] || null,
    blockingSession: (writeLease || rows[0]) ? (writeLease || rows[0]).session_id : null,
    leases: rows
  };
}

function acquireLease(sessionId, filePath, type = "exclusive_write", ttlMs = 60000) {
  if (!sessionId || !filePath) {
    return { ok: false, error: "MISSING_PARAMETERS", msg: "sessionId and filePath are required" };
  }

  reapStaleLeases();
  const db = getDb();
  const np = normPath(filePath);
  const leaseType = type === "shared_read" ? "shared_read" : "exclusive_write";
  const now = Date.now();
  const expiresAt = now + Math.max(Number(ttlMs) || 60000, 1000);

  // Check existing leases on this file
  const activeLeases = db.prepare("SELECT * FROM file_leases WHERE file_path = ?").all(np);

  // If another session holds an exclusive write lease -> Contention!
  const otherWriteLease = activeLeases.find((l) => l.session_id !== sessionId && l.lease_type === "exclusive_write");
  if (otherWriteLease) {
    return {
      ok: false,
      error: "CONTENTION",
      blockingSession: otherWriteLease.session_id,
      blockingLease: otherWriteLease,
      msg: `File ${filePath} is exclusively locked by session ${otherWriteLease.session_id}`
    };
  }

  // If this session wants exclusive write, but other sessions hold shared read leases -> Contention!
  if (leaseType === "exclusive_write") {
    const otherReadLease = activeLeases.find((l) => l.session_id !== sessionId);
    if (otherReadLease) {
      return {
        ok: false,
        error: "CONTENTION",
        blockingSession: otherReadLease.session_id,
        blockingLease: otherReadLease,
        msg: `File ${filePath} has active shared read leases from session ${otherReadLease.session_id}`
      };
    }
  }

  // Check if this session already holds a lease on this file -> renew / update
  const myExisting = activeLeases.find((l) => l.session_id === sessionId);
  if (myExisting) {
    db.prepare("UPDATE file_leases SET lease_type = ?, acquired_at = ?, expires_at = ? WHERE lease_id = ?")
      .run(leaseType, now, expiresAt, myExisting.lease_id);
    return {
      ok: true,
      leaseId: myExisting.lease_id,
      sessionId,
      filePath: np,
      type: leaseType,
      acquiredAt: now,
      expiresAt,
      renewed: true
    };
  }

  // Create new lease
  const leaseId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO file_leases (lease_id, session_id, file_path, lease_type, acquired_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(leaseId, sessionId, np, leaseType, now, expiresAt);

  return {
    ok: true,
    leaseId,
    sessionId,
    filePath: np,
    type: leaseType,
    acquiredAt: now,
    expiresAt,
    renewed: false
  };
}

function releaseLease(sessionId, filePath, leaseId = null) {
  reapStaleLeases();
  const db = getDb();
  let result;
  if (leaseId) {
    result = db.prepare("DELETE FROM file_leases WHERE lease_id = ?").run(leaseId);
  } else if (sessionId && filePath) {
    const np = normPath(filePath);
    result = db.prepare("DELETE FROM file_leases WHERE session_id = ? AND file_path = ?").run(sessionId, np);
  } else if (sessionId) {
    result = db.prepare("DELETE FROM file_leases WHERE session_id = ?").run(sessionId);
  } else {
    return { ok: false, error: "MISSING_PARAMETERS", msg: "sessionId or leaseId required" };
  }

  return { ok: true, released: (result.changes || 0) > 0, count: result.changes || 0 };
}

function renewLeases(sessionId, ttlMs = 60000) {
  if (!sessionId) return { ok: false, error: "MISSING_SESSION_ID" };
  reapStaleLeases();
  const db = getDb();
  const now = Date.now();
  const expiresAt = now + Math.max(Number(ttlMs) || 60000, 1000);

  const res = db.prepare("UPDATE file_leases SET expires_at = ? WHERE session_id = ?").run(expiresAt, sessionId);
  db.prepare("UPDATE agent_sessions SET heartbeat_at = ? WHERE session_id = ?").run(now, sessionId);

  return { ok: true, count: res.changes || 0, expiresAt };
}

function broadcastIntent(sessionId, message, files = []) {
  if (!sessionId || !message) {
    return { ok: false, error: "MISSING_PARAMETERS", msg: "sessionId and message are required" };
  }
  const db = getDb();
  const broadcastId = crypto.randomUUID();
  const now = Date.now();
  const fileArray = Array.isArray(files) ? files : [String(files || "")].filter(Boolean);
  const affectedFiles = JSON.stringify(fileArray);

  db.prepare(`
    INSERT INTO intent_broadcasts (broadcast_id, session_id, message, affected_files, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(broadcastId, sessionId, message, affectedFiles, now);

  return {
    ok: true,
    broadcastId,
    sessionId,
    message,
    affectedFiles: fileArray,
    createdAt: now
  };
}

function getActiveLeases(sessionId = null) {
  reapStaleLeases();
  const db = getDb();
  let query = "SELECT * FROM file_leases";
  const params = [];
  if (sessionId) {
    query += " WHERE session_id = ?";
    params.push(sessionId);
  }
  query += " ORDER BY acquired_at DESC";
  return db.prepare(query).all(...params);
}

function claimSymbol(sessionId, filePath, symbolName, symbolType = "function", intentSummary = "") {
  if (!sessionId || !filePath || !symbolName) {
    return { ok: false, error: "MISSING_PARAMETERS", msg: "sessionId, filePath and symbolName required" };
  }
  const db = getDb();
  const claimId = crypto.randomUUID();
  const np = normPath(filePath);
  const now = Date.now();

  db.prepare(`
    INSERT INTO symbol_claims (claim_id, session_id, file_path, symbol_name, symbol_type, intent_summary, claimed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(claimId, sessionId, np, symbolName, symbolType, intentSummary, now);

  return { ok: true, claimId, sessionId, filePath: np, symbolName, claimedAt: now };
}

function registerSession(sessionId, details = {}) {
  if (!sessionId) return { ok: false };
  const db = getDb();
  const now = Date.now();
  const harness = details.harness || "unknown";
  const worktreePath = details.worktreePath || "";
  const branch = details.branch || "";
  const status = details.status || "active";

  db.prepare(`
    INSERT INTO agent_sessions (session_id, harness, worktree_path, branch, status, heartbeat_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      harness = excluded.harness,
      worktree_path = excluded.worktree_path,
      branch = excluded.branch,
      status = excluded.status,
      heartbeat_at = excluded.heartbeat_at
  `).run(sessionId, harness, worktreePath, branch, status, now, now);

  return { ok: true, sessionId };
}

function close() {
  if (dbInstance) {
    try { dbInstance.close(); } catch {}
    dbInstance = null;
  }
}

module.exports = {
  initCoordination,
  acquireLease,
  releaseLease,
  renewLeases,
  reapStaleLeases,
  checkContention,
  broadcastIntent,
  getActiveLeases,
  claimSymbol,
  registerSession,
  close
};
