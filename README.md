# Agent HQ

**Agent HQ** is a local-first control plane and animated visual office simulator for AI coding agents. It unifies **Google Antigravity**, **Claude Code**, and **OpenAI Codex** sessions into a single retro-styled dashboard.

Agents sit at desks in rooms organized by repository, show real-time tool executions, celebrate turn completions, and can be steered or inspected without leaving your browser.

---

## Key Capabilities

### 1. Multi-Agent Ecosystem Support
* **Google Antigravity:** Ingests `transcript.jsonl` logs, tracking planner responses, tools (`swarm`, `run_command`, `read_file`), and Gemini token pricing.
* **Claude Code:** Full backward compatibility with local session transcripts, background roster management, and CLI resume/stop actions.
* **OpenAI Codex & Generic CLI:** Configurable transcript parsing and process control.

### 2. Animated Virtual Office
* **Harness Visuals:**
  * **Antigravity:** Zero-gravity floating animations with celestial orbit glow and holographic tablet props.
  * **Codex:** Emerald cybernetic scanner visor and retro phosphor CRT matrix screens.
  * **Claude:** Royal crown accents, wagging companion pet, and classic notebook prop.
* **Office Dynamics:** Steaming coffee mugs with sipping actions, typing sparks, idle stretching, pacing during tool runs, and turn-completion confetti.
* **Atmospheric Lighting:** Smooth dynamic transitions across day, dawn, dusk, and night.

### 3. Integrated Developer Workflow
* **8-Bit Retro Audio Engine:** Zero-dependency procedural Web Audio API cues for turn completions, attention requests, and warnings (with top-bar mute toggle).
* **Inline Syntax-Highlighted Git Diff Modal:** Inspect modified files (`+N / -N`) directly from an agent's desk in unified or side-by-side view.
* **Git Worktree Isolation:** Launch agents in isolated `git worktree` environments (`~/worktrees/<sid>`) to prevent `.git/index.lock` collisions.
* **In-Browser CRT Terminal Drawer:** View streaming agent stdout, thoughts, and tool traces in real time.
* **Level-1 Actionable Triage:** Review drafted answers in the "Needs You" tray and approve with one click or `Ctrl+Enter`.
* **Universal Sharding & Broadcast:** Use `/distribute` to fan out tasks across agents or `@all` to broadcast instructions to active workers.

---

## Quickstart

### Prerequisites
* Node.js (v18+)
* Git

### Launching the Dashboard

```bash
# Start Agent HQ in an app window (binds to http://127.0.0.1:7787)
node agent-dashboard.js --open
```

### Running Tests

```bash
# Run the complete automated test suite (94 checks)
node run-tests.js
```

---

## Architecture Overview

```text
agent-hq/
├── agent-dashboard.js        # Main local HTTP & Server-Sent Events server
├── worktrees.js              # Git worktree lifecycle engine
├── dispatcher.js             # Autonomous triage and draft generation
├── dispatcher-policy.json    # Policy rules for safe auto-triage
├── adapters/
│   ├── base.js               # Common adapter interface
│   ├── antigravity.js        # Google Antigravity transcript adapter
│   ├── claude.js             # Claude Code session adapter
│   ├── codex.js              # Generic / OpenAI Codex adapter
│   └── index.js              # Unified multi-agent registry & router
└── agents-ui/
    ├── world.html            # Main virtual office interface
    ├── alerts.js             # 8-bit procedural sound synthesizer
    ├── tray.js               # "Needs You" attention drawer & 1-click approvals
    ├── perf.js               # Fleet telemetry, costs, and KPI panels
    └── timeline.js           # Multi-agent turn execution swimlanes
```

---

## Security & Privacy

* **Strict Localhost Binding:** The dashboard server binds only to `127.0.0.1` with Host header validation to prevent local network exposure.
* **Read-Only Transcript Observation:** Existing agent sessions are observed through disk logs; actions are dispatched exclusively via sanctioned CLI entrypoints.
* **Untrusted Data Isolation:** Prompts and agent outputs are isolated within policy guardrails.
