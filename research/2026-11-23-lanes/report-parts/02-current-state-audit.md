## 2. Current-state architecture audit

Full text with line references and scripts: `research/2026-11-23-lanes/P0-current-state-audit.md`. Sources: my own code reading and measurements (parent), plus lane agents L2, L3, L4, L6, L7 who read the same code independently and ran their own experiments. Tags as in the status note.

### 2.1 What it is

| Layer | Files | Size | Behavior (VERIFIED, source read) |
|---|---|---|---|
| Server | `agent-dashboard.js` | 1706 lines | One Node process, plain `http`, loopback only (127.0.0.1:7787), Host-header check, per-run token on most POSTs, SSE push, exits after 20 minutes unwatched. |
| Adapters | `adapters/claude.js` 992, `antigravity.js` 655, `codex.js` 409, `base.js`, `index.js` | about 2.2k lines | Tail each harness's on-disk transcript JSONL by byte offset, fold events into per-session state, `scan()` returns normalized sessions. The Claude adapter overlays `claude agents --json --all` as authority for busy/idle/blocked. |
| Control | `startAgent`, `deliver`, `wake`, `message`, `drainQueue` | | Starts background Claude agents with `claude --bg`; follows up with `claude stop` then `claude --bg --resume <id> -- <text>`; queue in `~/.claude/state/agents-queue.json`. |
| Triage | `dispatcher.js`, `agents-ui/dispatch.js`, `tray.js` | 273 + 150 + 143 | Per waiting turn: `claude -p --model sonnet --json-schema`, label and draft a reply; send gate is rule id + self-reported confidence >= 0.8 + regex hints + rate limit; a human click sends. |
| Isolation | `worktrees.js` | 489 | `git worktree add ~/worktrees/<id>`, merge, cleanup, prune, diff, "speculative tests". |
| Coordination | `coordination.js` | 340 | node:sqlite WAL: sessions, file leases (60 s TTL), symbol claims, intent broadcasts. |
| Memory | `knowledge.js` | 237 | Append-only decisions, gotchas, triples. |
| UI | `agents-ui/world.html` and five scripts | 2168 + about 800 lines | DOM/SVG pixel office, tray, Web Audio chimes, perf and timeline views. |
| Tests | `run-tests.js` | 673 | 170 assertions. |

Zero dependencies. Flow: `fs.watch` (recursive) on the Claude project dir, the board dir and the Antigravity brain dir, plus a 4 s timer, schedule a push at most every 600 ms; each push rebuilds the whole fleet snapshot synchronously and sends all of it, plus every new raw transcript line of every session, to every client.

### 2.2 Measured baseline (VERIFIED, this machine, 2026-11-23)

| Metric | Value |
|---|---|
| Live server | 82.5 MB working set; `/api/state` 59 to 71 ms warm (551 ms cold), 77 KB; 1.17 pushes/s at 76 KB each (about 89 KB/s) |
| Browser | `render(d)` mean 6.8 ms, p95 10 ms; 3306 DOM nodes; 18 `log_line` plus 18 `term_chunk` events per 30 s even with the terminal drawer closed |
| Roster poll | `claude agents --json --all` 0.92, 0.32, 0.54 s per call, run at most every 4 s while a page is open |
| `/api/logs?tail=100` | 200 to 249 ms on a 33.8 MB transcript (whole file read and split); concurrent pings rise from 1.5 ms to 204 and 337 ms |
| Synthetic fleet 12 / 25 / 50 / 100 sessions | CPU 10.4 / 10.4 / 13.7 / 25.6%; state build 22 / 33 / 86 / 173 ms; payload 42 / 87 / 173 / 343 KB; append to screen p50 388 / 434 / 382 / 501 ms and p95 701 / 759 / 645 / 693 ms; ping stall max 558 / 528 / 1381 / 321 ms |
| CPU profile at 100 sessions | `readNew` 14%, snapshot body plus its cost reducer 16%, `price()` regex 3%, stat/open/read 23%, `pruneMetrics` twice 4.5%, GC 2.6%: about a third is recomputation a cached design would skip |
| fs.watch(recursive) on Windows | Cross-process burst of 1,000 appends: 143 coalesced events, 40 of 40 files seen; steady load: 405 events, 40 of 40. A usable change hint, not an event log |
| Corpus (7 days) | 49 top-level transcripts, 310 MB; 150 subagent transcripts; 463 completed turns in 38 interactive sessions |
| Coordination DB | 0 sessions, 0 leases, 0 symbol claims, 16 intent rows (all test fixtures); the test suite writes into the live `.state/coordination.db` |
| Tests | 166 of 170 pass with an empty HOME (4 need real sessions); 57 of 155 `assert` calls are `.includes()` string checks; 3 live HTTP checks; README says 94 checks |
| Dispatcher log (65 h, lane L7) | 237 attempts: 28 drafts (11.8%), 209 errors (88.2%); antigravity-kind success 7.7%, desktop-kind 64.7%; 0 would-send, 0 ratings, 0 sends; cost $0.0107 per successful draft, p50 latency 4.3 s; the daily cap of 150 is consumed by failures |

### 2.3 Defects (each reproduced or measured unless marked; severity is my judgment)

Delivery and one-click paths
- D1 (high, end to end with a stubbed CLI): `/api/dispatch/send` returns 500 "sentText is not defined" after it delivered; `acceptAndSendDraft` falls back to `/api/prompt`; one click produced two `claude --bg --resume` deliveries and two `claude stop` calls nine seconds apart.
- D2 (high): "Nudge" posts without the token header; server answers 403; UI shows "Nudged" and chimes.
- D3 (medium): "Revert Commit" posts to `/api/worktree/revert`, which does not exist (403, then 404 with a token).
- D13 (medium, static): queue entry is removed and persisted before delivery (at-most-once, lost on failure); `deliver` runs `claude stop` on a roster up to 4 s stale and kills a turn that just started; success is decided by a regex on CLI output; no idempotency key.
- D19 (high, static + live check): `CodexAdapter.deliver/stop` and `AntigravityAdapter.deliver/stop` return `ok: true` ("Sent to Codex agent", "Message queued", "marked stopped") without doing anything.
- D20 (high, live): `byHarness.codex` is 0 on the running server while 11 Codex rollout files exist; the adapter lists a flat directory but real files are `sessions/YYYY/MM/DD/rollout-*.jsonl` (some `.jsonl.zst`) whose records are `{type, payload}`, while `feed()` reads `role` and `usage`. Even if found, nothing would parse. Antigravity `startAgent` launches the Gemini CLI, not `agy`.

State and alerts
- D4 (medium): loop alarm is `errors10m >= 3 || errLog.length >= 3` with a 24 h log; replay over 7 days: 466 of 616 active samples flagged (75.6%), 416 only by the 24 h clause; strict repeat-loop proxy in 3 samples; it ranks above real questions in the tray.
- D17 (low): hook reach is measured (`hookReach`) but not used for state.
- Context gauge (lane L2): the planned thresholds (green below 40k, red above 120k) would turn 91% of this user's sessions red; on 1M-window models Claude Code compacts near 967k; after compaction the median context is already 48.9k; Claude, Codex and Antigravity count cached tokens differently (Codex's `cached_input_tokens` is a subset of `input_tokens`).

Isolation and landing (lane L6 reproduced D5 to D7 independently and found more)
- D5 (high): prune deletes branches with unmerged commits (`-D`), driven by directory mtime that does not move when nested files change; the "branch is merged" path is dead because `git branch --merged` prints `+ agent/x` for checked-out worktrees and the parser strips only `*`.
- D6 (high): the "speculative test" runs on the branch before merge; a semantic conflict merged cleanly and main then failed.
- D7 (high): `mergeWorktree` merges into whatever branch the root has checked out (not `target`), leaves `MERGE_HEAD` and conflict markers in the user's checkout on conflict (no `merge --abort`), and cleanup destroys uncommitted files in the agent worktree.
- Worktree id collisions: ids come from the first six words of the prompt; an existing directory is returned as success, so two agents (or two repos) can share one worktree. `worktree add -b` has no start point.
- Nothing in the shipped UI calls the merge, cleanup or prune endpoints; there is no landing path except these.

Security (parent reproduction; lane L3 and L7 agree)
- D8: coordination and intent POSTs skip the token and Origin check; `/api/stream/broadcast` and `/api/logs/emit` are unauthenticated GETs that inject text into every open terminal stream.
- D9: webhook secret defaults to a public string; a decision-less token is accepted for approve and reject; no expiry or nonce; a GET changes state; approve sends the newest draft for the session, not the draft the human saw.
- D10: all read endpoints are unauthenticated apart from loopback and the Host check.

Coordination, memory, cost
- D14 and lane L3: no caller renews leases, registers sessions, reads claims or reads broadcasts; lease keys are absolute worktree paths so two agents in two worktrees can never conflict; select-then-insert allowed double grants of an exclusive lease in 7, 2 and 6 of 3,000 contested files across two processes (0 with `BEGIN IMMEDIATE`); no fencing token.
- D15 and lane L2: `knowledge.js` is called only by tests; nothing injects it; the stored content is test fixtures.
- D16 and D18: cost dedupe by message id is correct (naive summing overstates 2.1x to 2.8x); but subagent transcripts, 17.9% of the week's API-equivalent cost ($218 of $1,216), are ignored; prices and the 1-hour cache-write rate are hard-coded in two places.
- D11, D12: synchronous whole-file reads in handlers; a dead second Claude parser inside `agent-dashboard.js` (so `wake()` looks up sessions in an empty map, INFERENCE); a second, older dashboard copy sits in `~/.claude/scripts`.

### 2.4 Strengths to keep (VERIFIED)

Zero dependencies and loopback-only design; incremental tailing with a torn-line guard and bounded memory; the adapter seam; correct usage dedupe; the dispatcher's no-tools, no-MCP, schema-constrained, human-click posture; the shadow-mode idea of logging a labeled dataset (it just never got labels); and the single "needs you" queue as the central abstraction.

### 2.5 What the documents claim that the code does not do

| Claim (README or research docs) | Reality |
|---|---|
| Unifies Antigravity, Claude and Codex | Claude works; Antigravity is read-only; Codex shows nothing |
| Speculative tests block ghost merges | Tests the branch; broken merge landed in the repro |
| SQLite intent leases prevent collisions, 15 s heartbeat, Tarjan deadlock resolver | Never called by any harness; no heartbeat; no waiting, so no deadlock to resolve |
| Knowledge fabric with sleep-time consolidation | Write-only fixtures; no consolidation |
| HMAC approvals expire in 15 minutes | No expiry, public default secret |
| Level-1 triage defeats rubber-stamping | 12% drafting success, 0 rated drafts, 0 would-send |
| 94 checks | 170 assertions, 57 of them string checks |
