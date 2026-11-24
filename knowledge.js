"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_KNOWLEDGE_DIR = process.env.AGENT_HQ_KNOWLEDGE_DIR || path.join(__dirname, ".hq", "knowledge");

function ensureKnowledgeDir(dir = DEFAULT_KNOWLEDGE_DIR) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Writes an automated Architectural Decision Record (ADR)
 * @param {Object} params
 * @param {string} params.title - Title of decision
 * @param {string} params.decision - The decision made
 * @param {string} params.rationale - Justification / reasoning
 * @param {string} [params.status] - Status (e.g. APPROVED)
 * @param {string} [params.sessionId] - Agent session ID
 * @param {string} [params.branch] - Git branch
 * @param {string} [params.author] - Author / agent
 * @param {string} [dir] - Knowledge directory
 */
function recordDecision(params = {}, dir = DEFAULT_KNOWLEDGE_DIR) {
  const kDir = ensureKnowledgeDir(dir);
  const filePath = path.join(kDir, "decisions.md");
  const now = new Date();
  const dateStr = now.toISOString();
  const adrNum = Date.now().toString(36).toUpperCase();
  const adrId = `ADR-${adrNum}`;

  const title = params.title || "Architectural Decision";
  const status = params.status || "APPROVED";
  const decision = params.decision || "(No decision text provided)";
  const rationale = params.rationale || "(No rationale provided)";
  const sid = params.sessionId || params.sid || "system";
  const branch = params.branch || "main";

  let header = "";
  if (!fs.existsSync(filePath)) {
    header = "# Architectural Decision Records (ADRs)\n\nAutomated decision history maintained by Agent HQ Cognitive Memory Fabric.\n\n---\n\n";
  }

  const record = `## ${adrId}: ${title}\n` +
    `- **Date**: ${dateStr}\n` +
    `- **Status**: ${status}\n` +
    `- **Session**: ${sid}\n` +
    `- **Branch**: ${branch}\n` +
    `- **Decision**: ${decision}\n` +
    `- **Rationale**: ${rationale}\n\n---\n\n`;

  fs.appendFileSync(filePath, header + record, "utf8");

  return {
    ok: true,
    adrId,
    title,
    status,
    path: filePath,
    recordedAt: dateStr,
  };
}

/**
 * Maintains repository hazard and test constraints
 * @param {Object} params
 * @param {string} params.issue - Hazard / pitfall description
 * @param {string} params.constraint - Requirement to prevent recurrence
 * @param {string} [params.severity] - Severity: WARN | CRIT | NOTE
 * @param {string} [params.component] - Affected component
 * @param {string} [params.sessionId] - Reporting session ID
 * @param {string} [dir] - Knowledge directory
 */
function recordGotcha(params = {}, dir = DEFAULT_KNOWLEDGE_DIR) {
  const kDir = ensureKnowledgeDir(dir);
  const filePath = path.join(kDir, "gotchas.md");
  const now = new Date();
  const dateStr = now.toISOString();

  const issue = params.issue || params.title || "Unspecified hazard";
  const constraint = params.constraint || params.rule || "(No constraint specified)";
  const severity = (params.severity || "WARN").toUpperCase();
  const component = params.component || "general";
  const sid = params.sessionId || params.sid || "system";

  let header = "";
  if (!fs.existsSync(filePath)) {
    header = "# Repository Gotchas & Hazard Registry\n\nOperational pitfalls and architectural constraints to guard against regressions.\n\n---\n\n";
  }

  const entry = `### [${severity}] ${issue}\n` +
    `- **Component**: ${component}\n` +
    `- **Constraint**: ${constraint}\n` +
    `- **Recorded**: ${dateStr} by session \`${sid}\`\n\n---\n\n`;

  fs.appendFileSync(filePath, header + entry, "utf8");

  return {
    ok: true,
    issue,
    constraint,
    severity,
    path: filePath,
    recordedAt: dateStr,
  };
}

/**
 * Records an entity triple into graph.jsonl
 * @param {Object} params
 * @param {string} params.subject - Entity subject
 * @param {string} params.predicate - Relationship predicate
 * @param {string} params.object - Target object
 * @param {string} [params.sessionId] - Recording agent ID
 * @param {number} [params.timestamp] - Timestamp
 * @param {string} [dir] - Knowledge directory
 */
function addTriple(params = {}, dir = DEFAULT_KNOWLEDGE_DIR) {
  const kDir = ensureKnowledgeDir(dir);
  const filePath = path.join(kDir, "graph.jsonl");

  const triple = {
    subject: String(params.subject || ""),
    predicate: String(params.predicate || ""),
    object: String(params.object || ""),
    sessionId: String(params.sessionId || params.sid || ""),
    timestamp: params.timestamp || Date.now(),
  };

  fs.appendFileSync(filePath, JSON.stringify(triple) + "\n", "utf8");

  return {
    ok: true,
    triple,
    path: filePath,
  };
}

/**
 * Reads all recorded ADR decisions
 * @param {string} [dir] - Knowledge directory
 */
function readDecisions(dir = DEFAULT_KNOWLEDGE_DIR) {
  const filePath = path.join(dir || DEFAULT_KNOWLEDGE_DIR, "decisions.md");
  if (!fs.existsSync(filePath)) {
    return { ok: true, text: "", count: 0, adrs: [] };
  }
  const text = fs.readFileSync(filePath, "utf8");
  const adrs = [];
  const regex = /## (ADR-[A-Z0-9]+):\s*([^\n]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    adrs.push({ id: match[1], title: match[2].trim() });
  }
  return {
    ok: true,
    text,
    count: adrs.length,
    adrs,
  };
}

/**
 * Reads all recorded gotchas
 * @param {string} [dir] - Knowledge directory
 */
function readGotchas(dir = DEFAULT_KNOWLEDGE_DIR) {
  const filePath = path.join(dir || DEFAULT_KNOWLEDGE_DIR, "gotchas.md");
  if (!fs.existsSync(filePath)) {
    return { ok: true, text: "", count: 0 };
  }
  const text = fs.readFileSync(filePath, "utf8");
  return {
    ok: true,
    text,
  };
}

/**
 * Reads the entity relationship graph from graph.jsonl
 * @param {string} [dir] - Knowledge directory
 */
function readGraph(dir = DEFAULT_KNOWLEDGE_DIR) {
  const filePath = path.join(dir || DEFAULT_KNOWLEDGE_DIR, "graph.jsonl");
  if (!fs.existsSync(filePath)) {
    return { ok: true, triples: [], count: 0 };
  }
  const content = fs.readFileSync(filePath, "utf8");
  const triples = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return {
    ok: true,
    triples,
    count: triples.length,
  };
}

/**
 * Summary helper for dispatcher and dashboard
 */
function getKnowledgeSummary(dir = DEFAULT_KNOWLEDGE_DIR) {
  const decisions = readDecisions(dir);
  const gotchas = readGotchas(dir);
  const graph = readGraph(dir);
  return {
    ok: true,
    decisionsCount: decisions.count || 0,
    triplesCount: graph.count || 0,
    hasGotchas: !!gotchas.text,
  };
}

module.exports = {
  DEFAULT_KNOWLEDGE_DIR,
  ensureKnowledgeDir,
  recordDecision,
  recordGotcha,
  addTriple,
  readDecisions,
  readGotchas,
  readGraph,
  getKnowledgeSummary,
};
