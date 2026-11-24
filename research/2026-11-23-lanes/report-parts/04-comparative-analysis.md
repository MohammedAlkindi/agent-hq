## 4. Comparative architecture analysis

Each decision lists the realistic options, scores them on the criteria that matter for a single-developer, Windows, local-first fleet of 7 to 19 sessions across several harnesses, and states what evidence the scores rest on. Ratings: ++ strong, + good, 0 neutral, - weak, -- poor. "Evidence" marks the strength of what supports the rating: V verified here, S strong external, W weak external, H hypothesis.

### 4.1 Observation: how Agent HQ learns what each agent is doing

| Option | Coverage of existing sessions | State fidelity | Latency | Fragility to harness changes | Windows | Effort | Evidence |
|---|---|---|---|---|---|---|---|
| A. Transcript tailing only (today) | ++ (every session, no setup) | - (no pending-approval state; silence is not death; Codex adapter parses nothing) | 0 (0.25 to 4 s) | - (9 Claude Code changelog versions touched transcript content; lag and rewrite bugs) | ++ | none (but Codex needs a rewrite) | V, S |
| B. Hooks first, transcript as backfill (Claude: HTTP hooks to the local server) | + (sessions started after the hook is configured; desktop sessions are reached: 18 `Stop` runs measured) | ++ (`PermissionRequest` at dialog open, `Notification` types, `PostToolUseFailure`, `StopFailure`, compaction events) | ++ (push, tens of ms) | + (documented, versioned events; hooks fail open so backfill is required) | ++ | M | S (docs), H (fidelity gain: E5) |
| C. Protocol-native drivers (Codex app-server and hooks, OpenCode SSE, Antigravity hooks and `agy` headless, ACP where present) | 0 (only sessions the harness exposes: Codex desktop attachability not documented; ACP is stdio and single-client) | ++ (Codex `WaitingOnApproval` and `WaitingOnUserInput`; OpenCode sequenced log with resync) | ++ | + (typed, generated schemas per version) | + (Codex and OpenCode Windows handling visible in source; not all run-tested) | M per harness | S (source read), H for Windows end to end |
| D. Terminal scraping (tmux, PTY screen stability) | - (needs tmux or ConPTY, sessions must run inside it) | 0 (prompt-string matching) | + | -- (ccmanager: about one patch per upstream UI change across 10 harnesses; agentapi archived) | - | M, then permanent upkeep | S |
| E. Own the process (Agent SDK, wrappers) | -- (only agents Agent HQ launches; desktop sessions excluded) | ++ | ++ | + | + | L | S |

Verdict: B for Claude Code, C where a harness offers it, A kept as the always-on backfill and the only path for sessions without hooks. D and E are rejected as primary designs. The deciding facts: the documented hook surface now exists and already runs on this machine (P3), Codex and OpenCode expose typed waiting states, and scraping has a measured maintenance cost. The deciding risk: hooks need the user's settings files to change; the research did not and will not change them, and all hook-driven state must degrade to transcript inference when events stop arriving.

### 4.2 State and data flow inside the server

| Option | CPU and latency at 100 sessions | Payload | Replay and test value | Complexity | Evidence |
|---|---|---|---|---|---|
| A. Rebuild snapshot from files each push (today) | 25.6% CPU, 173 ms build, stalls to 1.4 s | 343 KB per push | - (nothing recorded) | + | V |
| B. Per-session cached summaries with dirty flags; delta SSE keyed by session version | + (recompute only changed sessions; a third of CPU is avoidable per the profile) | ++ (changed sessions only) | 0 | 0 | V for the profile, H for the gain (E4) |
| C. Append-only event log (SQLite WAL or JSONL) with materialized views and sequence numbers | + | ++ | ++ (record and replay, golden timelines, audit) | - (migration, schema versioning) | S (OpenHands: 0.166 ms per event persist, 29.5 ms to replay 1,000 events), V for the need |

Verdict: B first (days to weeks, no new storage), C second because it also pays for the benchmark and the "why was I alerted" audit. A language or runtime change is not justified: parsing is cheap (a cold full read and parse of 117 MB took 1.2 s, lane L4) and the cost is recomputation and syscalls.

### 4.3 Coordination between concurrent agents in one repository

| Option | Measured or published effect | Enforcement | Failure modes | Verdict |
|---|---|---|---|---|
| A. Advisory TTL leases, never called (today) | None: 0 leases ever held; double grants across processes; no fencing; keys are per-worktree absolute paths so cross-worktree conflicts cannot be seen | none | silent | Retire as designed |
| B. Soft lease via PreToolUse (Claude, Codex, Antigravity hooks can all deny or warn before a write) | None published for agents; Chubby, Consul and Jepsen say advisory locks need fencing; Cursor: a task-claim lock slowed 20 agents to the throughput of 2 or 3 | partial (hooks fail open; Codex docs call hooks a guardrail) | held-too-long, forgotten release | Warn-only signal at most, behind an experiment |
| C. Isolation plus a serial landing queue | Cursor swarm: over 70,000 conflicts reduced to under 1,000 with a neutral resolver and decomposition; Gas Town Refinery tests the merged tree before pushing | at landing | slow landing if tests are slow | Adopt (A3) |
| D. Declared or inferred scope, serialize overlaps (sequential hand-off) | arXiv:2611.00314: hand-off 16% to 54% at equal tokens; Claim Plane: integration success 65.6% to 96.7%, mostly via serialization; CooperBench: plans halve conflicts but do not raise success | scheduling, not editing | scope under-declaration (46 of 90 dynamic runs failed closed) | Adopt as scheduler (A5); scope inference is the open risk |
| E. Shared CRDT workspace (AgentRoom) | n = 6 to 35 per cell, authors' own judge | invasive | harness integration | Reject |
| F. External supervisor ticks (SHEPHERD) | 28.8% to 54.7% pair pass on CooperBench | advisory steer, redirect, revert | supervisor cost, one benchmark | Research bet (R1) |

Verdict: C and D now, F as the research direction; A is deleted rather than patched.

### 4.4 Landing agent work

| Option | Prevents broken main | Protects the user's checkout | Cost | Evidence |
|---|---|---|---|---|
| A. Merge in the root after tests on the branch (today) | no (repro: clean merge, main red) | no (merges into whatever is checked out; leaves `MERGE_HEAD` and markers on conflict; cleanup deletes uncommitted files) | cheap | V (parent and lane L6) |
| B. Serial queue: merge target into a throwaway worktree, test there, fast-forward the target only if green, bounce failures to the agent, bisect batches | yes (tests the exact tree that will land) | yes | one test run per landing, serial or small batches; Zuul-style windows if throughput matters | S (GitHub queue, Zuul, bors-ng, Gas Town source) |
| C. B plus a structured-merge or LLM resolver as a conflict helper | same as B, plus fewer manual conflicts | yes | AST merge produced silent wrong merges in 11% of cases vs 3% for git (Java study); LLM resolvers match the developer's text 44 to 55% on small hunks | S: use only as an opt-in suggestion, never auto-land |
| D. Defer to GitHub PRs and its merge queue | yes | yes | needs a remote and CI; his own repos commit straight to main by rule | applicable to upstream repos only |

Verdict: B for local landing, C as optional help, D for repositories that already use PRs.

### 4.5 Attention, triage and the dispatcher

| Option | What it handles | Evidence | Verdict |
|---|---|---|---|
| A. LLM drafts a reply, gate on self-reported confidence (today) | Finished turns and questions after the fact | 28 drafts in 65 h, 0 would-send, 0 rated; 88% attempts failed; confidence takes 9 values and 14 of 28 are at 0.9 or higher | Keep as shadow only; fix reliability first |
| B. Deterministic eligibility and structured waiting reason from hooks, then a closed set of reply ids | Tool-permission prompts and questions with known shape | S (Anthropic classifier sees only tool calls; design patterns paper) | Adopt: removes free-text injection output |
| C. Vendor permission classifier (Claude Code auto mode) for tool prompts | The population behind the 93 to 97% approvals | Vendor: 0.4% false positive, 17% miss on overeager actions (n=52) | Offer, do not rebuild |
| D. Calibrated gate learned from ratings (conformal or exact binomial) | Any auto-send | Needs 59 error-free rated sends for a 5% bound, 299 for 1% | Only after implicit labels exist |
| E. Ordering, digest, WIP limit, away-mode reach | The 76% of wait minutes spent in gaps of two hours or more | V (local replay), S (queueing theory), W (interruption studies) | Adopt first |

### 4.6 Telemetry and cost

| Option | Accuracy | Coverage | Effort | Verdict |
|---|---|---|---|---|
| A. Transcript-derived cost with message-id dedupe (today) | right in principle (naive overstates 2.1x to 2.8x); hard-coded prices and cache TTL | misses subagents (17.9%); Codex formula differs and adapter is dead | S to fix | Keep, extend |
| B. OpenTelemetry from Claude Code and Codex | exact per-request cost (`cost_usd`, `api_request`) | needs env vars; Claude exporter has no file option (OTLP, Prometheus, console); traces beta; Codex default exporter points at a vendor endpoint | M | Use as ground truth in experiment E2, not as the live path |

### 4.7 Cross-cutting: what to build versus what the harness now owns

| Capability | Harness now provides | Agent HQ should |
|---|---|---|
| Worktree isolation and cleanup guards (Claude Code) | yes, with locks and "no unpushed commits" rule | stop creating its own for Claude; add landing only |
| Reply queue, supervisor, restart (Claude Code background sessions) | yes | stop `claude stop` plus `--resume`; use the supported path and the roster |
| Permission classification | auto mode (vendor) | surface blocks; do not clone |
| Cross-harness fleet view, attention scheduling, landing queue, capacity model | no harness does this | build and measure |
