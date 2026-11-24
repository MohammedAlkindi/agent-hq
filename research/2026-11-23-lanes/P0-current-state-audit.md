# P0: Current-state audit of Agent HQ (parent run)

Baseline: commit 86169e7 on main, read 2026-11-23 13:07 to 13:35 -08:00. No source was changed.
Tags: VERIFIED = read in source and/or reproduced or measured here. INFERENCE = deduced from verified facts. HYPOTHESIS = not tested.
Reproduction scripts and raw outputs were run against a throwaway clone under the session scratchpad with a fake HOME, never against the live server or real sessions. The live server (pid 36572) was only read through GET /api/state, /api/perf, /api/logs and /api/ping.

## 1. What it is (VERIFIED, source read)

| Layer | File(s) | Size | What it does |
|---|---|---|---|
| Server | agent-dashboard.js | 1706 lines | One Node process, plain `http`, loopback only (127.0.0.1:7787), Host-header check, per-run token for POSTs, SSE push, 20 min idle exit. |
| Adapters | adapters/claude.js 992, antigravity.js 655, codex.js 409, base.js, index.js | ~2.2k lines | Each adapter tails its harness's on-disk transcript JSONL incrementally (`readNew`, byte offset), folds events into a per-session state object, `scan()` returns normalized sessions. Claude adapter also overlays `claude agents --json --all` (Claude Code's own roster) as the authority for busy/idle/blocked. |
| Control | startAgent / deliver / wake / message / drainQueue in agent-dashboard.js | | Starts background Claude agents with `claude --bg`, follows up with `claude stop` then `claude --bg --resume <id> -- <text>`, queue persisted to ~/.claude/state/agents-queue.json. Other harnesses via their adapter's `deliver/stop/attach`. |
| Triage | dispatcher.js + agents-ui/dispatch.js, tray.js | 273 + 150 + 143 | Per waiting turn: spawn `claude -p --model sonnet --json-schema ...`, label + draft reply, gate on rule id + self-reported confidence >= 0.8 + regex + rate limit. Human click sends. |
| Isolation | worktrees.js | 489 | `git worktree add ~/worktrees/<id> -b agent/<id>`, merge, cleanup, prune, diff, "speculative tests". |
| Coordination | coordination.js | 340 | node:sqlite WAL: sessions, file leases, symbol claims, intent broadcasts. HTTP only (`/api/leases/*`, `/api/intent/broadcast`). |
| Memory | knowledge.js | 237 | Append-only ADR / gotchas / triple files in .hq/knowledge/. |
| UI | agents-ui/world.html 2168 lines (147 KB) + alerts, tray, perf, timeline, dispatch, hq-menu | | DOM/SVG pixel office, SSE client, drawers, tray, Web Audio chimes. |
| Tests | run-tests.js | 673 | 170 assertions in 16 sections. |

Dependencies: none (Node built-ins only; node:sqlite needs Node >= 22.5, running 24.18). External runtime deps: `claude` CLI, git, PowerShell (Task Scheduler query every 10 min), Chrome app window.

Execution flow (VERIFIED): fs.watch (recursive) on ~/.claude/projects, ~/.claude/state/board and ~/.gemini/antigravity/brain, plus a 4 s timer, schedule a push at most every 600 ms. Each push: `snapshot()` (sync) = rescan all adapters (stat + incremental read of every tracked transcript), read board files, list subagent dirs per session, stat worktree dirs, build metrics, call `dispatcher.consider()` (may spawn paid LLM jobs), `JSON.stringify` the whole fleet, write it to every SSE client; also stream every new raw transcript line of every session (`log_line` + `term_chunk`) to every client.

## 2. Measured baseline (VERIFIED, this machine, live server, 2026-11-23 13:1x)

| Metric | Value | Method |
|---|---|---|
| Server memory | 82.5 MB working set | Win32_Process |
| `GET /api/state` | first call 551 ms; next 7 calls 59 to 71 ms; 77.0 to 77.3 KB | curl, 8 sequential |
| State pushes to a browser | 35 in 30 s (1.17/s), 76.1 KB each (~89 KB/s); 18 `log_line` + 18 `term_chunk` events in 30 s even with the terminal drawer closed | in-page EventSource listener |
| Browser `render(d)` | mean 6.77 ms, p95 10 ms, max 11.2 ms; JSON.parse mean 0.44 ms; 3306 DOM nodes | wrapped `render` for 30 s |
| `claude agents --json --all` | 0.92, 0.32, 0.54 s per call; the server runs it at most every 4 s while a page is open | Measure-Command |
| `GET /api/logs?tail=100` on a 33.8 MB transcript | 200 to 249 ms, 756 KB response (reads and splits the whole file) | curl x3 |
| same, 23.3 MB / 4.3 MB | 140 to 256 ms / 25 to 61 ms | curl x3 each |
| Event-loop stall caused by that call | concurrent `/api/ping` 1.5 ms normally, 204 and 337 ms while logs calls ran | 12 pings during 6 log calls |
| Transcripts | 49 top-level files modified in 7 days, 310 MB total, largest 57 MB (untracked), largest tracked 33.8 MB, 12 modified in 24 h | filesystem |
| coordination.db in use | 0 sessions, 0 leases, 0 symbol claims, 16 intent broadcasts (WAL 807 KB vs 57 KB db) | read-only copy |
| Tests | 166 pass, 4 fail with an empty HOME (the 4 need real sessions on disk); 57 of 155 `assert(` calls are `.includes(` string checks; 3 live HTTP checks; README says 94 checks, suite has 170 | ran run-tests.js in a clone with fake HOME |

## 3. Verified defects (each reproduced or read in source; severity is my judgment)

D1 (high, reproduced). `POST /api/dispatch/send` returns 500 "sentText is not defined" after it has already delivered the message: the response object uses `sentText` (undefined) while the variable is `sendText` (agent-dashboard.js:1390 vs 1383). The browser helper `acceptAndSendDraft` (agents-ui/dispatch.js:34-44) treats a non-ok response as failure and falls back to `/api/prompt` with the same text. VERIFIED end to end (baseline server, stubbed `claude` CLI preload, the exact client sequence of dispatch.js): step 1 returned 500 "sentText is not defined" after `claude --bg --resume` had run; step 2 (fallback to `/api/prompt`) was queued because the agent was now busy and delivered nine seconds later by the queue drain: two `--resume` deliveries and two `claude stop` calls for one click. Real CLI behavior is assumed to match the stub (the dashboard's own header documents the same commands). Not caught by tests (they only check that the string `acceptAndSendDraft` exists).

D2 (high, reproduced). The "Nudge" button posts to `/api/dispatch/send` without the `x-agents-token` header (agents-ui/tray.js:110-113) so the server answers 403; the code only reacts to network errors, so the UI shows "Nudged <title>" and plays a chime while nothing was sent.

D3 (medium, reproduced). The "Revert Commit" button posts to `/api/worktree/revert`, which does not exist (403 without token, 404 "Unknown action" with token). Dead feature; test suite passes because it only checks the button text exists.

D4 (medium, reproduced). "Loop thrashing" (tray + desk alert + audio alarm) is `errors10m >= 3 || errLog.length >= 3` (tray.js:19, world.html:1308). `errLog` keeps up to 24 h of failed tool calls (pruneMetrics), so any session that had three failed tool calls in a day, however old or different, is flagged; the text says "consecutive errors" but nothing checks consecutiveness, repetition or recency. It outranks real questions in the tray (rank -1). Live snapshot: 3 of 7 active sessions flagged; 0 of the 3 had the same tool+error 3 times; 1 was flagged only through the 24 h rule (0 errors in the last 10 minutes). n is tiny: the mechanism is VERIFIED, the false-positive rate is HYPOTHESIS until replayed over the 7-day corpus (see experiment E3).

D5 (high, reproduced). `worktrees.pruneInactiveWorktrees` decides "inactive" from the worktree directory mtime and, when no uncommitted files exist, force-removes the worktree and runs `git branch -D`. Repro: a branch with one unmerged commit, worktree dir mtime 72 h old, `prune` reports "inactive (72.0h old)", branch gone afterwards (commit object only reachable through reflog until gc). Directory mtime does not change when files in subdirectories are edited, so it is a poor activity signal.

D6 (high, reproduced). The "speculative pre-flight tests" in `mergeWorktree` run in the agent's branch worktree before the merge, not on the merged result. Repro: agent A changes `f(a)` to `f(a,b)` and updates its caller; main meanwhile adds a second caller using the old signature plus a test covering both. `mergeWorktree({runTests:true})` returned ok, no conflict, branch deleted; tests on main afterwards: FAIL. This is the "ghost merge" the research docs say the feature blocks.

D7 (medium, reproduced). The merge runs `git merge --no-ff` in the repo root (the user's main checkout) with no check that the checkout is clean, on `main`, or not in use by another session.

D8 (medium, reproduced). `/api/leases/*` and `/api/intent/broadcast` POSTs skip the token and Origin check (agent-dashboard.js:1340). A request with `Origin: http://evil.example` got 200. `/api/stream/broadcast` and `/api/logs/emit` are unauthenticated GETs that push arbitrary text into every open terminal stream (tested: 200). Any web page the user opens can reach 127.0.0.1:7787 with a no-cors request. INFERENCE for impact (text injection into the UI the human trusts; lease/intent tampering), since responses are unreadable cross-origin.

D9 (medium, reproduced). `WEBHOOK_SECRET` falls back to the string `agent-hq-dispatch-secret-2026` (public in the repo). An offline-computed HMAC of the session id returned 200 for both `approve` and `reject` on `GET /api/dispatch/webhook-approve`. The verifier also accepts a decision-less token (`HMAC(sid)`) for any decision, tokens have no expiry or nonce (the research doc specifies 15 minutes), and the action is a state-changing GET. Reachability is limited to local callers because the server binds loopback and checks Host; the defect is real but its blast radius is local malware or a rebound page that learns a session id.

D10 (low-medium, VERIFIED static). `GET /api/state` and every read endpoint need no token; `/api/stream` forwards every session's raw transcript lines to every client. Protection is only loopback bind plus Host check. Fine for a single-user laptop, but a local-process or browser-extension attacker reads all transcript text.

D11 (medium, VERIFIED static + measured). Synchronous O(file size) transcript reads in request handlers: `/api/logs` and `/api/stream?sid=` use `fs.readFileSync(st.file)` then `split("\n").slice(-N)`. 200 to 250 ms event-loop stalls on a 34 MB transcript; `FULL_READ_MAX` of 40 MB bounds only the incremental reader. Every `/api/diff` call also rebuilds a full `snapshot()` just to find one session.

D12 (low, VERIFIED static). Dead and duplicated code: agent-dashboard.js still carries its own `S` map, `feed`, `readNew`, `relist`, `subagentList` for Claude transcripts (never populated: no `S.set` anywhere) alongside adapters/claude.js. Consequence (INFERENCE): `wake()` looks sessions up in the dashboard's empty `S`, so waking a finished Claude session from the prompt box returns "not in the last day's transcripts" (sandbox run could not confirm end to end: the roster was unavailable under the fake HOME). `PRICES` and `costOf` exist twice (identical values today) so any price update must be made twice. A second, older copy of the dashboard sits at ~/.claude/scripts/agent-dashboard.js (75,851 bytes vs 87,778; different).

D13 (medium, VERIFIED static). Delivery semantics: `drainQueue` removes the message from the queue and persists that before calling `deliver`; a failed or interrupted delivery is reported only in the in-memory `radio` list and the message is gone (at-most-once, lossy). `deliver` stops a Claude background agent (`claude stop`) when the roster, which can be up to 4 s stale, says it is not working; if a turn started meanwhile, the stop kills it. `ok` for delivery is decided by a regex on CLI output (`/backgrounded/`), with no idempotency key, so a retry after a parse miss double-sends.

D14 (medium, VERIFIED static). Coordination layer is not wired in: nothing in the harness configs or hooks calls the lease API (searched ~/.claude/settings.json and ~/.claude/scripts), `registerSession` and `renewLeases` are never called by the server, `claimSymbol` has no reader, `symbol_claims` never expire, `acquireLease` is read-then-write without a transaction, and the unique constraint in the research spec was dropped. The overlap warning the user actually sees ("Both editing X") comes from a different system, the session board (`~/.claude/state/board/*.json`).

D15 (low, VERIFIED static). `knowledge.js` only appends. Nothing in the dispatcher prompt or any adapter reads it back, no relevance retrieval, no dedupe, ADR ids are `Date.now()` base36. The "consolidation daemon" of the research doc does not exist.

D16 (low-medium, VERIFIED static). Cost/pricing assumptions are hard-coded: cache writes are charged at 2x input ("because settings.json sets ENABLE_PROMPT_CACHING_1H"), a price table dated 2026-11-03. The per-message dedupe (keyed by message id, latest usage wins) is correct in principle and is the main protection against the known transcript double-counting. Accuracy against a known-truth log has not been checked (experiment E2).

D17 (low, VERIFIED static). Hooks are measured but not used: `hookReach()` counts `stop_hook_summary` entries to prove hooks reach desktop sessions (18 runs in one session on 2026-11-16), yet state is still inferred from transcript tails plus a polled CLI roster.

## 4. Strengths worth keeping (VERIFIED)

1. Zero dependencies, loopback-only, single process: easy to run and reason about; startup in under a second.
2. Incremental byte-offset transcript tailing with partial-line guard and a bounded-memory prune (24 h) is a sound core and cheap (state build ~60 ms for 12 sessions).
3. The adapter seam (`BaseAdapter`: scan/owns/startAgent/deliver/stop/attach) already separates harnesses; the Claude adapter uses the official `claude agents --json` roster as ground truth for busy/idle/blocked.
4. Prompt-injection posture of the dispatcher is better than average: no tools, no MCP, no settings, no session persistence, data tags, schema-constrained output, human click required (the safety review itself is lane L7).
5. Human-in-the-loop design: every send is a click; shadow mode with ratings logs a labeled dataset (the audit.jsonl) from which gate quality can be measured.
6. The tray's idea (one ordered queue of everything waiting on the human) is the right abstraction for the actual bottleneck; the data model already has `since`, `question`, `stuck`, `blocked`.

## 5. Limits and bottlenecks (INFERENCE from the numbers above)

- Snapshot work is O(sessions) per push even when one transcript changed; at 12 sessions it is ~60 ms synchronous per push, ~7% of one core at the observed 1.17 pushes/s. Linear scaling to 50 sessions would be ~250 ms per push, which breaks the 600 ms cadence. Cost is dominated by repeated stat/readdir and full JSON build, not by parsing (HYPOTHESIS until profiled; E4).
- Payload is the full state every push (76 KB); a delta protocol would cut it by an order of magnitude when one session changes (HYPOTHESIS).
- The CLI roster call (0.3 to 0.9 s per call, every ~4 s) is the most expensive recurring work and sits on an official surface that hooks could replace (HYPOTHESIS: needs measurement of CPU share, E4).
- The human is the throughput limit (lane L7 model), so detector precision (D4) and one-click delivery correctness (D1, D2) matter more than rendering speed.

## 6. Addendum: replay and scale measurements (VERIFIED, run 2026-11-23 on this machine)

### 6.1 Loop-detector replay over 7 days of local transcripts (script replay-loop.js, aggregate output only)

49 transcripts, 9,399 tool results, 436 failed (4.6%). 60.5% of session-days (46 of 76) contain three or more failed tool calls; median 4 failures per session-day, p90 15, max 31. Sampling every 10 minutes while a session was active (616 samples), the dashboard rule (`errors10m >= 3 || errLog >= 3`) flags 466 samples (75.6%): 50 by the 10-minute clause, 416 only by the 24-hour clause. A strict loop proxy (three or more consecutive failures of the same tool with the same input within 15 minutes) occurs in 3 samples; all 3 were flagged (recall 100%) but precision against that proxy is 3 of 466 (0.6%). Caveat: the proxy is strict (a real loop with slightly varying input would be missed); even if true loops were ten times the proxy count, precision would stay near 6%. Ground-truth labeling of a sample of flags is still needed (experiment E3).

### 6.2 Synthetic scale benchmark of the baseline server (script bench-scale.js; fake HOME; 2 MB synthetic transcripts; 8 sessions each get an appended tool step about every 1.5 s; 40 s per run; one SSE client)

| Sessions | /api/state mean / p95 (ms) | state size (KB) | server CPU | server RSS (MB) | pushes/s | SSE KB/s | append to UI latency p50 / p95 / max (ms) | /api/ping during load p95 / max (ms) |
|---|---|---|---|---|---|---|---|---|
| 12 | 21.7 / 38.2 | 42 | 10.4% | 140 | 1.49 | 85 | 388 / 701 / 1004 | 70 / 558 |
| 25 | 33.0 / 41.6 | 87 | 10.4% | 170 | 1.50 | 158 | 434 / 759 / 948 | 158 / 528 |
| 50 | 86.2 / 164.4 | 173 | 13.7% | 262 | 1.42 | 279 | 382 / 645 / 1642 | 96 / 1381 |
| 100 | 173.0 / 263.6 | 343 | 25.6% | 314 | 1.47 | 521 | 501 / 693 / 915 | 181 / 321 |

Reading (INFERENCE): state build and payload grow linearly with session count (about 1.7 ms and 3.4 KB per session), CPU rises from 10% to 26% of one core, and event-loop stalls (ping max 0.3 to 1.4 s) appear from 25 sessions up. The 600 ms push debounce plus the 250 ms watch delay put a floor of about 400 ms (p50) on append-to-screen latency regardless of size; at 100 sessions a single push costs about 175 ms of blocking work. The fleet this developer actually runs (7 to 19 sessions) sits at the cheap end, so scale is not today's bottleneck; it is a design-headroom issue. Limits of this test: synthetic content, empty CLI roster, a single client, no 24 h pruning effects.

### 6.3 Cost accounting checks (scripts replay-cost.js, replay-subagent-cost.js; 7 days, 50 main transcripts, 150 subagent transcripts; aggregate only)

- Naive summation over assistant rows would overstate usage: 15,981 rows with usage but only 7,484 unique message ids (median 2 rows per message, max 19). Naive/deduped ratios: output 2.76x, cache read 2.14x, cache write 2.63x, input 2.20x. So Agent HQ's per-message-id "latest wins" rule (adapters/claude.js `calls` map) is necessary and correct in design; in all 7,484 messages the last row carried the maximum output count (0 exceptions), so latest-wins does not under-count output. This matches the developer's own measurement of about 2.5x.
- New defect D18 (VERIFIED static + measured): usage in subagent transcripts is never read. The adapter only stats `<id>/subagents/*.jsonl` for liveness (claude.js:545-557) and drops sidechain rows (claude.js:329). Over the same 7 days those 150 subagent files hold 4,429 deduped calls and $218.03 of API-equivalent cost (Agent HQ's own price table, 0 unpriced calls) against $997.95 in the main transcripts, i.e. 17.9% of total spend is invisible to the "Last 24h" cost, to the per-desk burn gauge and to any budget governor built on it. (Caveat: if a main transcript also embeds sidechain rows, a small part of the $218 overlaps; not separated here.)

### 6.4 CPU profile of `snapshot()` (script profile-snapshot.js, `node --cpu-prof`, synthetic fleet, 8 sessions appended per iteration, 40 iterations)

snapshot() p50 is 29.6 ms at 12 sessions and 154 ms at 100 sessions (p95 33.7 and 198 ms); JSON.stringify is only 0.3 to 2.7 ms. Self time at 100 sessions: `readNew` 14.3%, `snapshot` body 9.8% plus its cost reducer 6.5% (it re-prices every call of the last 24 h on every push) plus `price()` regex search 3.3%, filesystem syscalls (stat 8.4%, open 6.0%, read 3.2%, readFileUtf8 5.3%) about 23%, `scan` 6.5%, `pruneMetrics` twice (dashboard and base.js) 4.5%, GC 2.6%. INFERENCE: roughly a third of the work is recomputed aggregates and repeated stat/open calls that an event-driven, cached design would skip; the profile does not support a rewrite to another language or runtime.

### 6.5 Where agent idle time actually goes (script replay-turns.js; 7 days; 38 interactive sessions, 8 scheduled excluded; aggregate only)

463 completed agent turns. Agent turn length: median 0.9 min, p75 3.4, p90 9.2, mean 9.7. Human reply gap (end of turn to next human prompt, gaps under 12 h, n = 434): median 2.2 min, p75 13.3, p90 84.9, mean 37.1; 18% exceed 30 minutes. Share of total human-wait minutes by gap size: under 5 min 2% (n 275), 5 to 30 min 7% (n 83), 30 to 120 min 15% (n 41), 120 min and over 76% (n 35). Mean agent turn divided by mean human gap is 0.26.

Reading (INFERENCE): agents do wait on the human, but about three quarters of the waiting is a few long "away" gaps, not slow approvals. Speeding up the common 2-minute reply can recover at most about 9% of idle time; the large pool is the gaps of two hours and more. That favors (1) letting an agent continue with a pre-authorized next step or queue instead of stopping at a question, (2) reaching the human away from the desk, (3) ordering the queue so long-blocked high-value items surface first, over making the in-office click faster. Limits: one user, one week, "human gap" includes sleep and breaks under 12 h, turn end is inferred from `stop_reason`, not from a question flag.

### 6.6 fs.watch(recursive) behavior on this machine (script watch-test2.js; Node 24.18, Windows 11; 40 files in 5 folders; writes from a separate process)

Burst of 1,000 appends in 2.1 s produced 143 events (coalesced) and every one of the 40 files received at least one event; a steady 800 appends over 4.1 s produced 405 events, 40 of 40 files covered. A first attempt that wrote from inside the watching process saw only 2 events and 1 of 40 files, because the synchronous writes starved the callbacks (a confound, and a reminder that the server's own 60 to 175 ms synchronous snapshot work delays event delivery). VERIFIED: the watcher is a usable "something changed" hint with coalescing and no lost files in two cross-process rounds; it is not an event log. The current design (hint, then stat and read-from-offset) is the right pattern; the 4 s timer is a safety net, not a necessity for correctness. Limits: a 64 KB OS buffer overflow under much heavier load was not provoked.

### 6.7 Cost of the roster poll and the first-party session registry (2026-11-24, measured here)

`claude agents --json --all` run six times: 0.20 to 0.27 s of CPU and 0.27 to 0.36 s wall each (mean 0.24 s CPU). Agent HQ calls it at most every 4 s while a page is open, so the poll costs about 6% of one core in a child process, outside the server process's own CPU (10.4% at 12 synthetic sessions; the synthetic fleet had an empty roster). INFERENCE: roughly a third of Agent HQ's total CPU at 12 sessions is the roster poll; replacing it with the registry files or hook events removes that (experiment E4 will measure it). `~/.claude/sessions/<pid>.json` exists on this machine for the live interactive and Desktop sessions (4 files; keys: pid, sessionId, cwd, startedAt, procStart, version, kind, entrypoint, messagingSocketPath, name, status, updatedAt, statusUpdatedAt; `status` seen: idle, busy), which confirms lane L5's finding. Whether `status` can express a permission wait is still not verified.
