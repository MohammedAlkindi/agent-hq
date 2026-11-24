# Agent HQ: evidence-backed improvement research report

Date: 2026-11-23 to 2026-11-24. Baseline: commit 86169e7 (main), unchanged. No Agent HQ source was edited; only files under `research/` were written (reports, notes and measurement scripts). Throwaway clones and fake home directories under the session scratchpad were used for every experiment that ran code.

How to read this. Every finding carries one of three tags. VERIFIED: the primary source or code was read, or the measurement or reproduction was run, on this machine or by a named lane agent (lane files record which). INFERENCE: reasoned from verified facts. HYPOTHESIS: untested. Where a number was relayed by a summarizing fetch tool rather than read in the page, the lane file says so and the report marks it "relayed". All counts of sessions, tokens and dollars come from scripts in `research/2026-11-23-lanes/bench/` that print aggregates only; no transcript content is quoted anywhere.

Contents: 1 Executive summary; 2 Current-state architecture audit; 3 Research and repository review; 4 Comparative architecture analysis; 5 Prioritized roadmap; 6 Implementation proposals; 7 Experimental validation plan; 8 Rejected alternatives, refuted claims, open questions; 9 Research record (time, coverage, limits, files).

Where the evidence lives: `research/2026-11-23-improvement-research-ledger.md` (clock, waves, stop reason); `research/2026-11-23-lanes/` holds the parent audit (`P0`), primary-document checks (`P3`), the experiment plan (`P4`), the arXiv id cross-check (`P1`), eight lane reports (`L1` to `L8`) with source lists and commit SHAs, and `bench/` with every script behind a number.

## 1. Executive summary

Question: how should Agent HQ improve its architecture, performance, reliability, scalability, orchestration and capabilities, judged against primary sources, production harness source code, and measurements on this machine. Baseline: commit 86169e7, unchanged.

**Verdict in five lines**

1. The core is sound and cheap; the edges are not. Incremental transcript tailing, the adapter seam, per-message cost dedupe and the loopback server work (state build 22 ms at 12 sessions, 173 ms at 100). But three of the product's headline claims do not hold in the code: "multi-harness" (the Codex adapter finds zero of the 11 Codex session files on this machine; Codex and Antigravity "send" and "stop" are no-ops that report success), "Level-1 triage" (88% of dispatcher drafting attempts failed, 0 of 28 successful drafts would have been sent, 0 drafts were ever rated), and "collision-free isolation" (the pre-merge test gate tests the branch, not the merge; prune deletes unmerged work; the lease database has never held a real lease).
2. More than a dozen defects were reproduced by running code, not just read (the full list is in section 2). The ones a human trusts most are worst: one click on "Accept & Send" delivers the reply twice and shows an error (end to end, stubbed CLI); "Nudge" shows success while the server refused it; the loop alarm fires on 75.6% of active samples while a strict repeat-loop proxy occurs in 0.6% of flags.
3. The earlier research documents' key citations mostly fail on contact with the sources. "MAST proves 93% rubber-stamping" is wrong (the 93% is an Anthropic auto-mode figure, 97% five months later); AgenticFlict measures PR-versus-base conflicts, not agent-versus-agent, and has no "84%"; the "75 to 85% input tokens" figure is not in the cost paper; "knowledge fabric", "sleep-time consolidation", "Tarjan deadlock resolver" and the 15-minute HMAC expiry do not exist in code and have no supporting evidence. All 57 arXiv ids the lanes cite resolve on arXiv with matching titles and dates; the problem is attribution and unsupported figures, not invented papers.
4. The strongest evidence points to different bets than the earlier plan. For parallel work in one repo: serialize overlapping tasks (a single sequential hand-off lifted success from 16% to 54% at the same token cost, arXiv:2611.00314, the setting closest to Agent HQ's), land through a tested serial queue (Cursor's swarm post: from more than 70,000 merge conflicts to under 1,000 after harness changes; Gas Town's Refinery tests the merged tree before pushing), and supervise from outside with cheap batched ticks (SHEPHERD, arXiv:2605.10913: 28.8% to 54.7% pair pass rate). Fine-grained pre-edit locks, AST merge drivers and message broadcasting have weak or negative evidence (in a Java study of about 6,000 merges judged by the projects tests, Spork-style AST merge produced 11% silently wrong merges versus 3% for git, figures read by lane L6 from the paper).
5. The human bottleneck sits in a different place than assumed. On this developer's last week 76% of all human-wait minutes come from 35 gaps of two hours or more; the 358 gaps under 30 minutes make up 9%. A faster approve click cannot recover much. Ordering, away-mode reach, and letting agents continue on a pre-authorized next step can. A finite-source queueing model (lane L7, parameters still placeholders until Z and S are measured) puts saturation at N* = (Z + S) / S agents; with plausible values the fleet of 7 to 19 is past it unless a human touch costs about a minute, which is why a capacity measurement comes before any scheduler claim.

**What the landscape changed since the earlier plan (all VERIFIED from docs or source, 2026-11-23)**: Claude Code now ships a documented supervisor and reply queue for background sessions, `claude agents --json` as the supported external read surface, its own worktree isolation with locks and cleanup rules, 33 hook events including HTTP hooks, `PermissionRequest` and `Notification(permission_prompt)`, and an OpenTelemetry span `claude_code.tool.blocked_on_user`. Codex exposes `codex app-server` (JSON-RPC) with typed thread status `WaitingOnApproval` and `WaitingOnUserInput`, hooks and `exec --json`. OpenCode serves HTTP plus SSE with a sequenced event log and a resync marker. Antigravity's `agy` has hooks and headless JSON. Third-party orchestrators that still scrape terminals (ccmanager) pay about one detector patch per upstream UI change across ten harnesses. Agent HQ's remaining unique value is therefore cross-harness fleet awareness, attention scheduling, and landing, not re-implementing worktrees, queues and supervision that the harnesses now own.

**Recommended path (ranked; details in sections 5 and 6)**

| Rank | Change | Why now | Effort |
|---|---|---|---|
| 1 | Truthfulness and safety fixes: real or honestly unsupported deliver/stop, exactly-once one-click send, safe prune and merge, closed local API, fixed loop alarm, dispatcher reliability | Reproduced defects in the paths the human trusts | days |
| 2 | Layered harness drivers: hooks and official protocols first (Claude HTTP hooks, Codex app-server, OpenCode SSE, Antigravity hooks), transcripts as backfill, capability flags per driver | Removes the approval-wait blind spot and the 0.3 to 0.9 s roster poll; ends format-drift exposure | weeks |
| 3 | Serial landing queue that tests the merged tree in a throwaway worktree | The only landing path today lets a broken merge through | weeks |
| 4 | Attention scheduler with a capacity model, digest, away reach | 76% of wait minutes are long gaps; saturation math | weeks |
| 5 | Overlap-aware scheduling (declare or infer scope, serialize overlaps), retire the unwired lease database | Best-evidenced coordination result for this setting | weeks |
| 6 | Incremental, event-sourced snapshot with delta push | Scale headroom (CPU 10% to 26% from 12 to 100 sessions, stalls to 1.4 s) | weeks |
| 7 | External supervisor agent and a local record-replay fleet benchmark | Novel and well-motivated, but single-benchmark evidence | research |

Nothing above is claimed to improve performance until its experiment (section 7) shows it. Baseline numbers for every experiment already exist.

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

## 3. Research and repository review

Coverage: eight lanes screened several hundred candidates (lane L7 alone: 56 sources, 16 read in depth; lanes L1 to L6 each read 10 to 25 primary sources in depth). Every entry below was read from the primary source (paper PDF text, official docs, repository source at a named commit, issue threads) by the lane named; where a lane used a summarizing fetch it says so in its file, and those numbers are marked "relayed". Full lists with commit SHAs and file paths: lane files `L1` to `L8`. Each row answers: what it is, how the mechanism works, how strong the evidence is, and whether and where it applies to Agent HQ.

### 3.1 Parallel agents, coordination and supervision (lane L1, VERIFIED unless marked)

| Source | Mechanism | Evidence | Applicability |
|---|---|---|---|
| Kim et al., arXiv:2512.08296 (Google, DeepMind, MIT, 2025-12; v3 2026-04) | 260 configurations of single, independent, centralized, decentralized, hybrid agent systems on 6 benchmarks | Gains from +80.8% to -70.0% vs one agent; SWE-bench Verified: all multi-agent variants -2% to -15% (20-instance subset); above about 45% single-agent accuracy, adding agents hurts; error amplification 17.2x independent, 4.4x centralized; predictive R^2 only 0.373 | Do not fan out by default for coding. Make parallelism a scheduler decision |
| Mediratta et al., arXiv:2611.00314 (UT Austin, NVIDIA, 2026-10) | Independent requests from one developer to agents in a shared repo, no orchestrator; contradictory vs complementary task pairs; single-agent oracle | Contradictory pairs: oracle 62%, parallel-unaware 16%; peer awareness 16% to 26% (not significant); messaging up to 32% at 1.4 to 2.2x tokens; one sequential hand-off 16% to 54% at about equal cost; post-hoc merge or LLM reconciliation recovers 10 to 16% | Closest match to Agent HQ's setting. Supports serialization of overlapping tasks over locks and messages (proposal A5) |
| CooperBench, arXiv:2601.13295 (Stanford, SAP, 2026-01) | 600+ tasks; two agents implement compatible but potentially conflicting features | Two agents about 30% below one agent; success 68.6% (2 agents), 46.5% (3), 30.0% (4); first-turn plan halves conflicts (29.4% vs 51.5%) without raising success | Plans reduce conflicts, not failures; keep fan-out small |
| Claim Plane, arXiv:2607.21909 and 2608.00947 (single author, 2026-07/08) | Agents declare scope before editing; overlapping scopes are serialized; static and dynamic admission | Pair pass 23.3% to 50.0%, integration success 65.6% to 96.7%, but 96.7% of executions serialized; dynamic admission failed closed on undeclared scope in 46 of 90 runs | Enforcement works mostly by serializing; scope inference is the hard part (HYPOTHESIS for transfer) |
| SHEPHERD, arXiv:2605.10913 (Northeastern, Stanford, 2026-05) | Meta-agent subscribes to workers' tool-call streams, one batched decision per agent every 5 s from none, steer, redirect, revert; prompt under 3K tokens | CooperBench pair pass 28.8% (none) to 45.3% (Sonnet) and 54.7% (Opus); solo ceiling 57.2%; supervisor adds 1.4 to 4.3 min per pair | Agent HQ already sees the streams. Best-evidenced novel capability (research bet R1); one benchmark, weak workers |
| Wink, arXiv:2602.17037 (Meta, 2026-02) | Asynchronous observer LLM every 5 steps injects a course correction | 10,000+ trajectories: 29.2% show a misbehavior; one intervention resolves 90.93%; live A/B: tool failures -4.2%, tokens -5.3%, engineer interventions -4.2% | Real but modest; sets expectations for any observer |
| Zhao et al., arXiv:2607.09510 (UCL, 2026-07) | 3,843 Terminal-Bench trajectories, 1,794 annotated | Median decisive error step 7, lock-in about step 12; a prefix monitor flagged only 3.7 to 8.7% of failures at or before lock-in (2 to 3% false positives); 71% of successful runs also hit an error | An error count is the wrong alarm; early failure detection is genuinely hard |
| OpenHands StuckDetector (source, commit 0988e97) | Four deterministic patterns over the last 20 events: identical action and observation 4 times; same failing action with same error 3 times; 3 consecutive messages with no tool call; alternating A,B,A,B over 6 pairs | Production code; no published precision/recall | Concrete replacement for the loop rule (experiment E3) |
| Cursor "agent swarm model economics" (2026-07-20) and "Scaling long-running autonomous coding" (2026-01-14) | Swarm builds SQLite in Rust; old vs new harness; earlier flat swarm with a shared task-claim lock | Old harness over 70,000 merge conflicts (hottest file 7,771 by 1,173 agents); new under 1,000 (hottest 47); new runs scored 73 to 85% at 4 h vs 11 to 77%; lock anecdote: 20 agents slowed to the throughput of 2 or 3 (one sentence, task-claim lock, not file leases); four configurations, vendor-run | A neutral conflict-resolving stage and decomposition matter more than lock granularity |
| Anthropic C compiler write-up (2026-02-05) | 16 agents in containers, text lock files in `current_tasks/`, git as sync, bash restart loop | About 2,000 sessions, about $20,000; parallelism collapsed when all agents hit the same bug; fixed by an oracle that partitioned the work | Locks as task claims work for coarse tasks; test oracles drive partitioning |
| Co-Coder, arXiv:2606.00953 | Static dependency graph, community detection, dependency-aware scheduling | Spec-to-repo tasks: 68.1% vs sequential 56.8%, 442 s vs 800 s; Claude Code Agent Teams 54.1% | Dependency-aware partitioning beats naive file parallelism; generation, not editing |
| CoAgent, arXiv:2606.15376 | Classic 2PL and OCC versus notify-and-repair for agents on shared mutable state | 2PL 1.04x, OCC 0.93x speedup; notify with saga undo 1.4x at within 5% of serial correctness | Locks and abort-retry waste minutes of inference; not source-edit workloads |
| Passes Alone, Fails Together, arXiv:2609.25396 | Mined and constructed Django PR pairs | Real independent PRs rarely interfere semantically (1 of 417 pairs after correction); constructed interference 97%, a message describing the other change recovered 82% | Semantic interference is real but rarer in organic work; sharing a summary of the other change is cheap |
| Agent HQ-adjacent first-party features (docs read in full) | Claude Code agent teams, background supervisor and queue, worktrees | Docs say sequential, same-file and dependency-heavy work belongs in one session; teammates should own disjoint file sets | Partition by ownership, not by lock |

Claims from the earlier in-repo documents that lane L1 checked: MAST "proves 93% rubber-stamping" REFUTED (MAST is an agent-to-agent failure taxonomy; the 93% is Anthropic's auto-mode post of 2026-03-25, 97% in the 2026-08-07 post); AgenticFlict "84% cross-agent conflicts in core logic" UNSUPPORTED (it measures single-agent PR vs base, 27.67% overall; the 84.4% figure is a different quantity from arXiv:2607.04697); "75 to 85% input tokens" UNSUPPORTED (paper: about 154 input tokens per output token, cache reads dominate cost); Cursor lock contention CONFIRMED but narrower; Devin error amplification UNSUPPORTED (product announcement only).

### 3.2 Landing, merge and isolation (lane L6, VERIFIED unless marked)

| Source | Mechanism | Evidence | Applicability |
|---|---|---|---|
| AgenticFlict, arXiv:2604.03551 (AIware 2026) | `git merge --no-commit --no-ff` of 107,026 open or closed-unmerged agent PRs onto their base | 27.67% conflict rate; Copilot about 15%, Codex about 32%; larger PRs conflict more; textual only | A base-rate for conflicts, not agent-vs-agent |
| Xu, Subramanian, Karthik, arXiv:2607.04697 (2026-07) | 747 co-active PR pairs replayed with `git merge-tree` | Intra-agent pairs 19.8% conflict, cross-agent pairs 41.7% (CI 33.1 to 50.9); 84.4% of conflicted files are source files | The only direct number on agent-vs-agent conflicts; public repos, textual only |
| Schesch et al., arXiv:2410.09934 (ASE 2024) | 5,983 Java merges judged by project tests | git ort: 46% correct, 51% conflict, 3% incorrect; Spork (AST): 54%, 35%, 11% incorrect; IntelliMerge 50% incorrect | AST merge converts conflicts into silent wrong merges; if a wrong merge costs more than about 2x a conflict, plain git wins |
| Merge-Bench, arXiv:2605.25890 | 7,938 small real conflict hunks, text match to developer resolution | Best models 54.7% exact (Java); Opus 4 left markers in 21.2%; test-free | LLM conflict resolution is useful as a suggestion, not an auto-lander |
| Mergiraf on Linux history (LWN 2025-10) | Tree-sitter structural merge | 428 of 7,415 conflicting merges fully resolved (5.8%); correctness not reported | Opt-in helper only |
| GitHub merge queue, Zuul, bors-ng (docs, README) | Temp branch holds base plus queued changes; CI on the combined tree; failure removes the change and rebuilds followers; bors bisects batches | Production practice at scale; bors-ng archived in favor of GitHub's queue | The correct landing algorithm: speculative combined-tree test, serial or small-batch, bisect on failure |
| Gas Town Refinery (source at 94cc822) | LLM formula plus a Go engine: rehearsal merge of target into branch, gates on merged tree, merge slot lock, flaky retry, batch and bisect | Source read; the repo's own comments say post-squash gates catch "broken imports" | Closest open-source design to what Agent HQ lacks |
| Claude Code worktrees (docs read in full) | `--worktree`, background isolation, `git worktree lock` while running, cleanup only if no changed files and no unpushed commits, no built-in merge | Official behavior; issues #34645 and #47266 show concurrent `worktree add` racing on `.git/config.lock` | Agent HQ's own worktree code duplicates and is weaker than the harness; use the harness's isolation and add only landing |
| Execution isolation on this host | Windows Sandbox absent (Home edition), no Hyper-V module, WSL2 has only docker-desktop, Docker Desktop 29.9.3 running; Claude Code's sandbox is unsupported on native Windows; Codex ships a native Windows sandbox crate (dedicated user, firewall and WFP rules, restricted token, ACLs) | Probed and source read | "Zone B airlock" is feasible only as Docker containers; there is no OS sandbox for Claude agents here |

### 3.3 Observation and steering surfaces (lane L4 plus parent doc check, VERIFIED unless marked)

| Harness | Best observation channel | Steering channel | State fidelity | Notes |
|---|---|---|---|---|
| Claude Code | 33 hook events; HTTP hooks POST to a URL; `claude agents --json` (documented as the supported external read); OTel with `claude_code.tool.blocked_on_user` span (beta) | `claude --bg --resume`; `claude agents` replies queue; Channels for permission relay (research preview) | `PermissionRequest` fires when the dialog opens; `Notification(permission_prompt)` after about 6 s; `idle_prompt` about 60 s | Transcript path "written asynchronously and can lag"; transcript drift entries in 9 changelog versions (GC rewrites, torn lines, placeholder usage in subagent files) |
| Codex | `codex app-server` JSON-RPC (`thread/status/changed` with `WaitingOnApproval`, `WaitingOnUserInput`), `exec --json`, hooks crate (PreToolUse, PermissionRequest, Stop and more), rollout files | `turn/start`, `turn/steer`, `turn/interrupt`; approval requests are server-to-client calls | Only harness whose protocol natively distinguishes approval-wait, question-wait and idle | Rollouts are nested by date, cold files zstd-compressed, canonical parser required; generated TS and JSON schemas ship with each version |
| OpenCode | HTTP + SSE; `GET /api/event` (volatile by contract), sequenced per-session log and `log.synced`, `GET /api/permission/request` for resync | prompt, interrupt, permission reply, form reply endpoints | 101 typed event variants | Cleanest observe-and-resync design |
| Gemini CLI | Hooks (command only), `--output-format stream-json`, ACP and an experimental A2A server | ACP | Notification is observability only | |
| Antigravity (`agy`) | Hooks (PreToolUse with decisions, Stop with `fullyIdle`), headless `--output-format stream-json`, `transcriptPath` handed to hooks | `agy -p`, `--conversation` | No dedicated waiting event | Agent HQ launches the Gemini CLI instead of `agy`; brain transcript contains CHECKPOINT rows the adapter ignores |
| Others | OpenHands event stream with `resend_mode` since a timestamp; Crush SSE; Amp stream-json; Goose and Cline via ACP | | | ACP is stdio only today (streamable HTTP is an RFD); no way for a second client to attach to a session another owns |

How others detect state: ccmanager scrapes the terminal for ten harnesses and has needed about one detector patch per upstream UI change (issue #227, then a flip-flop of reverts #279 and #281); claude-squad hashes tmux pane text and matches hard-coded prompt strings; coder/agentapi (PTY screen stability) was archived by its maintainer; claude-control and pixel-agents use hooks first and fall back to heuristics (pixel-agents: 7 s permission timer, 5 s idle timer, suppressed once a hook event has been delivered). Third-party manager agent-monitor dedupes usage by message id for Claude and by `token_usage_record` for Codex.

### 3.4 Durability, delivery and coordination theory (lane L3, VERIFIED unless marked)

| Source | Mechanism | Evidence | Applicability |
|---|---|---|---|
| Kleppmann 2016; Chubby (OSDI 2006); Consul sessions; etcd mutex and Jepsen 3.4.3 | Locks that can expire need a fencing token checked by the resource; real systems keep locks advisory and add sequencers | Jepsen: etcd locks unsafe under short TTLs (about 18% of acknowledged updates lost in the test); Chubby rejected mandatory locks | A TTL lease with no fencing and no enforcement cannot protect an edit; at best it is a hint (efficiency lock) |
| Claude Code hooks, Codex hooks, Antigravity hooks (docs) | PreToolUse can allow or deny before the write; Codex docs: "useful guardrail, not a complete enforcement boundary"; hook failure can let the tool run | Official docs | A lease can be enforced softly at PreToolUse for all three harnesses; hard enforcement needs a different layer |
| Claude Code background supervisor and queue (agent-view docs) | Supervisor restarts exited sessions, persists state, queues replies to a working session, saves undeliverable replies for the next prompt | Official docs | Agent HQ's `claude stop` plus `--resume` duplicates and undermines this; changelog 2.1.285 fixed a reply approving a pending command |
| Gas Town issues #2036, #1379, #4674, #4949 | LLM and daemon watchdogs inferred death from heartbeat or tmux activity | Confirmed from issues and source: live agents killed, unpushed commits lost | Never let a silence heuristic act; label only (matches Agent HQ's "stuck" today) |
| OpenHands event-sourced state | `base_state.json` plus one file per event, crash recovery by matching actions to observations | Their benchmark: median persist 0.166 ms per event, replay of 1,000 events 29.5 ms | An append-only fleet log is cheap and recoverable |
| LangGraph SqliteSaver, Restate, DBOS, Temporal, Inngest | Checkpoint or journal every step; resume replays; effects are at-least-once, journaled results exactly-once | Read from schema and protocol text | Use idempotency keys plus a journal for delivery; do not adopt a workflow engine for this scale |
| Stripe idempotency keys; transactional outbox | Store first result per key and replay it; write message and state in one transaction | Official docs | The right shape for "send this reply to session X" |
| SQLite WAL docs; lane experiment | `BEGIN IMMEDIATE` takes the write lock up front; checkpoint at 1000 pages; WAL of 807,552 bytes is exactly 196 frames, benign | Experiment: two processes, 3,000 contested files, plain code gave 7, 2, 6 double grants, `BEGIN IMMEDIATE` gave 0 | If any lease is kept, use a transaction and a monotonic generation number |

### 3.5 Context, memory and trajectory efficiency (lane L2, VERIFIED unless marked)

| Source | Mechanism | Evidence | Applicability |
|---|---|---|---|
| CodeNib, arXiv:2607.25431 (authors' own harness) | Multi-view index served as bounded packs, retired after first read | "50 to 87% fewer tokens" is localization only; "outperforms on-demand" = 79 vs 66 resolved on 200 SWE-bench tasks, one cheap model, one run, USD 1 budget; repo-clustered CI [-3.9, +17.4]; with USD 2 on non-Django tasks the gap shrinks to 50 vs 46 | In-repo claim is a compressed over-generalization; not applicable to Agent HQ (an MCP server a harness must call) |
| Complexity Trap, arXiv:2508.21433 (JetBrains) | Observation masking (keep last 10 turns' observations) vs LLM summarization | About 50% cost cut at equal solve rate; summaries lengthen trajectories 13 to 15% | Do not build a summarizer for other tools' sessions; masking belongs inside the harness |
| Evaluating AGENTS.md, arXiv:2602.11988 (ETH) | Context files generated by agents vs written by developers | Generated files: -0.5 to -2 points success, +20 to 23% cost; developer files +2.4 points (not significant), up to +19% cost; companion study arXiv:2601.20404 found -28.6% runtime with AGENTS.md (conflicting); arXiv:2611.09802: stale instructions cost about a third more tool calls and agents never repaired them | Do not auto-write and auto-inject `knowledge.js` content; if kept, human-curated, short, staleness-checked |
| Sleep-time compute, arXiv:2504.13171 (Letta, Berkeley) | Precompute inferences before the query | About 5x less test-time compute on predictable math queries; does not study memory consolidation or ADR files; weaker at high budgets on SWE | Does not support a "knowledge consolidation daemon" |
| Mem0, Zep, A-MEM, LongMemEval, LoCoMo | Vendor memory systems | Every headline number is vendor-run conversational QA with disputed benchmarks; Letta's plain-filesystem agent scored 74.0% vs Mem0's self-reported 68.5% | No coding evidence; plain files plus grep are competitive |
| Context rot (Chroma), NoLiMa, RULER | Long-context degradation on synthetic tasks | Real degradation with length on 2024 to mid-2025 models; none on current coding agents | "Long context is not free", not a threshold of 120k |
| Local telemetry (this machine, 163 transcripts, 14 days) | Per-session maximum context | p50 294k, p90 834k; 91% of sessions exceed 120k; 54 auto-compactions fired anywhere from 166k to 1.0M; median post-compaction 48.9k; median compaction 72 s (max 268 s, session looks idle) | Gauge must use per-harness window and the `compact_boundary` records, and must not read compaction as idleness |
| Cost studies: arXiv:2604.22750, CORVUS arXiv:2607.22711, arXiv:2607.12161, arXiv:2609.22114 | Token consumption analyses and compression experiments | Repeated file reads: 26% of read actions on one model; a tool-output compressor cut tokens 38.4% yet raised billed cost 6.8%; tool-schema filtering the only reliably positive lever | Spend breakers are supported; tool-output compression from outside is not |

### 3.6 Human attention, triage and safety (lane L7, VERIFIED unless marked)

| Source | Mechanism | Evidence | Applicability |
|---|---|---|---|
| Anthropic auto mode (engineering post 2026-03-25; blog 2026-08-07, updated 2026-10-22) | Two-stage transcript classifier on tool calls (single-token filter, then reasoning on flagged), blind to assistant prose and tool results, plus an injection probe; 3 consecutive or 20 total denials escalate | Internal traffic: false-positive rate 8.5% (stage 1) to 0.4% (full), miss rate on real overeager actions 17% (n=52); users approved 93% (March) and 97% (August) of manual prompts; 1,053-tester study: humans caught 13.6% of an injected dangerous command vs 89% for auto mode (vendor-run, relayed) | Settles the 93% provenance. The vendor classifier covers the tool-prompt population Agent HQ cannot even see today |
| Verbalized-confidence calibration: Kadavath 2207.05221, Tian 2305.14975, Xiong 2306.13063, agentic 2601.07264 and 2601.15778 | LLM-stated confidence versus accuracy | Overconfident, weak across tasks; mid-run confidence near-useless (AUROC at most 0.60), end of turn 0.85 | 0.8 as a send permission is invalid; as a veto it is harmless. In the log, 9 distinct values in 28 draws and 14 at 0.9 or higher |
| Prompt-injection literature: CaMeL 2503.18813, design patterns 2506.08837, spotlighting 2403.14720, Attacker Moves Second 2510.09023, JudgeDeceiver 2403.17710, AI coding tools 2603.21642 | Defenses and adaptive attacks | Adaptive attacks beat 12 published defenses above 90%; up to 84% malicious command execution in coding assistants | The dispatcher turns untrusted agent prose into a trusted-channel reply (confused deputy). Closed reply sets and tool-call-level decisions are the strong mitigations |
| Queueing model (finite-source M/M/1, computed by the lane) | One human server, N agents with mean work Z between asks and service S | Saturation at N* = (Z + S) / S; e.g. Z=15, S=3 gives N*=6; throughput flat at 1/S beyond it | Agent efficiency falls toward 1/N past saturation; a WIP limit and ordering matter more than draft quality |
| Interruption science: Adamczyk and Bailey 2004, Iqbal and Bailey 2008, Mark 2008, Ancker 2017, Buçinca 2021, Parasuraman and Manzey 2010 | Breakpoint timing, alert repetition, forcing functions | Lab and clinical studies, indirect | Alert only blocked and high-cost items, digest the rest, never re-alert the same turn |
| Dispatcher log (65 h) | 237 attempts, 28 drafts, 0 would-send, 0 ratings | Exact Clopper-Pearson: bounding the false-send rate at 5% needs 59 error-free rated sends, 1% needs 299 | No safety claim is possible today; reliability fixes and implicit labels come first |


### 3.7 Evaluation, telemetry, cost and loop detection (lane L8, VERIFIED unless marked; 45 sources screened, 15 read in depth, plus one headless known-truth run costing about $0.03)

| Source | Mechanism | Evidence | Applicability |
|---|---|---|---|
| Known-truth run (lane L8) | One headless `claude -p --model haiku --output-format json` run, compare Agent HQ's computation with the vendor's `modelUsage` and `total_cost_usd` | Tokens matched exactly (4 + 71,792 input side, 187 output, 119,336 cache read). Dollars were 45% low on that run because Haiku 5.5 requests above 100k prompt tokens cost 5x (862 of 865 Haiku 5.5 messages on this machine are above 100k) | The dedupe is right; the price table is not. n = 1 run, so the exact error rate is not established |
| ccusage (commit 40655d4, source) | Recursive scan including subagent files; cross-file dedupe on message id plus request id; keeps the row with the largest token total | Production tracker, same 2.5x bug found in Claude Code's own UI (issue #94224) | Template for the fix: subagents, cross-file dedupe, tie-break by largest total |
| Claude Code issues #95555, #84223 | Rows with zeroed counters; placeholder snapshots in subagent files | Documented hazards; not observed in 7 local days | "Last row wins" is the wrong tie-break |
| Local price audit (lane L8) | Compare `PRICES` with Anthropic's pricing page, Google's page | Fable 5.1 cache read priced at $1.00 instead of $0.25 (+$67 of $143 for that model in a week); 1-hour cache-write rate applied to every write although the transcript records the tier (subagents are 94% 5-minute); `usage.speed` ignored; Gemini 3.8 Flash table out of date (about 4x low for three variants, INFERENCE); Claude models inside Antigravity priced with the Gemini fallback; 7.7% of message ids repeat across resumed transcripts (6.7% overcount) | The cost panel has errors in both directions; a tier-aware formula matched the vendor to the cent on the known-truth run |
| Loop detection survey (OpenHands, Roo, Cline, OpenCode, SWE-agent, mini-swe-agent, Aider; source and docs) | Exact-match thresholds of 3 to 5 identical calls; budget and turn caps; OpenHands adds same-error and monologue patterns | Every shipping detector is exact-match with a small window; none publishes precision or recall; none uses edit distance | Replace the alarm with tiered exact-match detectors |
| Published detector numbers (arXiv HTML read) | Cosine similarity cycle detection; learned early-failure monitors | Cosine above 0.85 alone: precision 0.16, recall 0.91; with structural confirmation 0.62 and 0.86 (one app, 57 positives, tuned on test); learned monitors about 30.5% recall at 5% false-alarm rate; within-task AUC 0.50; continuing beat restarting in 216 of 224 configurations | Alerts must be advisory, never automatic kills |
| Replay on this machine (lane L8, parent) | The documented design (Levenshtein above 0.85, 3 consecutive, identical error) | Fires 0 times in 7 days; without the error condition fires 76 times, 73 of them healthy work; "12 tool calls without an edit" would fire on 22% of turns | The brake in the research document is unsupported and noisy |
| Benchmarks and harness variance (Anthropic Terminal-Bench 2.0 note, Epoch, Terminal-Bench 2.1 paper, a 300-trial harness study) | Fixed model, vary harness or resources | 6 points from resource limits alone; 11 to 15 points from scaffold (relayed); about 41x tokens per solved task across harnesses at 0 to 8 points pass-rate difference | The harness-model pair is the unit; cost per accepted change beats spend leaderboards |
| Claude Code and Codex OpenTelemetry (docs, source) | Per-request tokens, `cost_usd`, `request_id`, cache tiers, subagent ids; `claude_code.tool.blocked_on_user` span; Codex uses OTel GenAI attribute names | Claude exporter has OTLP, Prometheus and console but no file sink; traces beta; OTel GenAI conventions are "Development" status and moved repositories in 2026 | Use OTel as a second ledger for reconciliation, not as the live path; adopt OTel attribute names for the internal record instead of the research doc's custom UTMP schema |

Claims from the earlier documents checked by lane L8: "12 tool calls without an edit" brake UNSUPPORTED (package not found); "input tokens are 75 to 85% of spend" UNSUPPORTED as a figure (on this machine the input side is 88.3% of API-equivalent cost: cache read 45.6%, cache write 42.7%); "accuracy peaks at intermediate cost" CONFIRMED with caveats; UTMP schema duplicates OTel GenAI and omits request id, parent agent id, cache-tier split and speed.

### 3.8 Orchestrator and control-plane source teardown (lane L5; about 60 candidates screened, 15 read in depth, 70+ issue bodies read; VERIFIED unless marked)

| Project (commit) | Mechanism | Evidence from source and issues | Lesson for Agent HQ |
|---|---|---|---|
| Gas Town (94cc822) | Go daemon, Dolt SQL, tmux roles; Refinery = batch-then-bisect merge queue with a merge slot; `gt nudge` writes files that the agent's UserPromptSubmit hook drains at the next turn boundary; AI watchdog tiers | False kills traced to wrong liveness signals, not short timers: 22 sessions killed in one incident (#2707), a healthy Mayor restarted about 50 times a day (#4787), a tmux field that never tracks output (#4949), quota waits that look like hangs (#4887); queue silently drops past 50 (#4634); concurrent spawns crash on one shared settings file (#3500) | Landing queue and turn-boundary hook delivery are reusable; the watchdog is the cautionary tale: never let a silence heuristic act |
| Claude Squad (070eb93) | tmux per agent in a worktree; status = hash of the captured pane; literal prompt strings; no merge (push a branch, human merges) | Windows binary non-functional (#275, open, no reply); prompt typed before the CLI is ready lost (#266); synchronous polling cost about 1.66 s per tick at 8 sessions (contributor measurement) | Pane-hash status and string matching are the weakest detection; copy only "park as Paused and offer resume" when the process vanished |
| Vibe Kanban (3f095f0) | Rust server with SQLite; each agent a child process with an executor; squash merge only, refuses if the base moved, in-memory libgit2 merge when the base is not checked out | 10+ agents supported (the earlier note said Claude and Aider only: REFUTED); worktrees took 26 GB in about two days (#765); single in-memory queued message per session lost on crash; shut down 2026-04-10 for business reasons, repo still committing | Copy "refuse if base moved" and in-memory merge; sunsets were commercial, not technical |
| ccmanager (b0948dd), pixel-agents (4dd14d6), Orca, Orchestrator.inc, T3 Code, Herdr | Screen scraping (ccmanager, 10 harnesses); hooks first with transcript fallback and 7 s and 5 s heuristic timers (pixel-agents); managed hooks plus an OSC 7501 escape-sequence protocol with a 2-minute silence fallback (Orca); facts-not-status with a reaper, a mass-death breaker and "never type into a blocked session" (Orchestrator.inc); transactional outbox with settle milestones (T3 Code) | Status detection is the dominant failure class and format drift its main cause (ccmanager #227, pixel-agents #93 and #162 after a Claude Code transcript change, T3 #7589 and #15197, Orchestrator.inc #6280, Orca #16902); Orchestrator.inc's reaper terminates only when runtime and process are both dead, treats a failed probe as unknown, and trips when more than half of at least five sessions look dead in one pass | Hooks first, first-party registry second, transcript third, screen scrape last; add the guard layer (two independent signals, probe failure = unknown, mass-change breaker) before any automatic action |
| Claude Code agent view, cross-session messaging, agent teams (docs, changelog, local probe) | `claude agents --json` (0.74 s here), `~/.claude/sessions/<pid>.json` with pid, procStart, status, messaging socket path for interactive and Desktop sessions; per-session inbox socket with an auth key on native Windows (from 2.1.234); teams with file-locked task claims and disjoint file ownership | About 60 changelog items in two months for agent view (research preview), so the surface will move; whether interactive `status` can express a permission wait and whether an external process may post to the inbox on Windows are NOT verified | Use the registry as the liveness source; evaluate the inbox before keeping `claude --resume` delivery |
| OpenAI Symphony SPEC, Cursor posts | Reconcile-before-dispatch, keep workers running when a refresh fails, retry backoff; Cursor removed its central integrator as a bottleneck | Specs and vendor posts, no measurements | Reconcile-before-act and fail-keep-running are portable; stall-kill is the same family that hurt Gas Town |

Scale facts from the field and from this machine: failures come from per-agent child processes and memory, not orchestrator CPU. Agent Orchestrator failed at about 15 live Codex workers on an 8 GB Mac (518 zsh, 378 gh and 294 rg processes in 45 minutes) and at 40 to 45 workers elsewhere; on this 31.4 GB machine at measurement time 20 `claude` processes held 2.7 GB (largest 843 MB), 104 `node` processes 1.06 GB, and only 3.2 GB of RAM was free. So at 7 to 19 sessions RAM headroom and process churn are the limit, which makes admission control and a resource panel (M7) worth more than a faster scheduler. Sunset drivers were commercial or maintainer time: Vibe Kanban (no business model), Crystal (vendor pivot to Nimbalyst), Overstory (author moved on), Claude Squad (two maintainers with day jobs); Conductor, Roo Code and Terragon reasons come only from secondary sources and are not relied on.

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

## 5. Prioritized improvement roadmap

Scoring: impact H/M/L on this developer's workflow; evidence V (verified here by reproduction or measurement), S (strong external primary source), W (weak or vendor-only), H (hypothesis); effort S (days), M (weeks), L (months); risk of making things worse L/M/H. Ranking is by expected value, that is impact times evidence strength divided by effort, with correctness and safety defects first because the human relies on those paths.

### 5.1 Quick improvements (days each; 9 items, all low risk)

| Rank | ID | Change | Impact | Evidence | Effort | Depends on | Measurable success |
|---|---|---|---|---|---|---|---|
| 1 | Q1 | One-click delivery that tells the truth: repair the `sentText` crash, remove the double-send fallback, make the client trust the server, give every send an idempotency key and an outbox row (queued, sending, delivered, unknown, failed) that is acked only after the user prompt appears in the target transcript; make Codex and Antigravity `deliver` and `stop` return `unsupported` instead of `ok: true`; never run `claude stop` on a session that is working, blocked or has a stale roster; fix Nudge's token; remove or build Revert | H | V (D1, D2, D3, D13, D19) | S | none | E1: 1,000 randomized trials, 0 duplicates and 0 losses outside the crash class; UI status equals delivery truth in 100% |
| 2 | Q2 | Replace the loop alarm with tiered exact-match detectors scoped to the current turn (3 identical calls: possible loop; 4 identical action-observation pairs or 5 identical calls: hard loop; same error 3 times; 3 messages without a tool call; A,B,A,B), a separate "long tool" label for the 8-minute silence, and a "quota or auth blocked" state excluded from all detectors; alerts advisory only, ranked below real questions; never kill or type on a signal | H | V (D4: 75.6% flagged vs 0.6% proxy precision) + S (OpenHands source; shipping detectors are exact-match; learned monitors about 30% recall at 5% false alarms) | S | none | E3: precision at least 70%, at most 0.5 alerts per active session-day, 0 automatic actions |
| 3 | Q3 | Make worktree handling safe: merge in the root only when it has `target` checked out and clean (otherwise merge in a temporary worktree and move the ref), `merge --abort` on any failure, per-repo mutex, delete a branch only with `-d` or `merge-base --is-ancestor` proof, activity from `git log -1`, reflog and session heartbeat instead of directory mtime, parse `+ branch` markers, refuse to touch a worktree a live session's cwd is inside, give worktrees collision-proof ids and an explicit start point, never destroy uncommitted files on cleanup | H | V (D5, D7, L6 experiments) + S (Claude Code's own guards: lock, no unpushed commits) | S to M | none | E7: 0 unreachable commits in 2,000 randomized states |
| 4 | Q4 | Close the local API: token and Origin check on every state-changing route (including coordination), no state change on GET, remove `/api/stream/broadcast` and `/api/logs/emit`, random per-install webhook secret created on first use (server refuses to enable webhooks without it), tokens bound to (sid, decision, draft key, expiry, nonce), POST only | M | V (D8 to D10) | S | none | E10: attack suite passes in CI |
| 5 | Q6 | Cost correctness in one pass: read subagent transcripts, dedupe across files by (message id, request id) keeping the row with the largest total, price cache writes from the recorded tier, add the missing tiers and models (Haiku 5.5 above 100k, Fable 5.1 cache read, speed), per-harness usage formulas, show "unpriced" instead of 0, label the figure "API-equivalent estimate", add a known-truth test | M | V (known-truth run; D16, D18; naive sums 2.1x to 2.8x) | S to M | none | E2: within 2% per day and 5% per session against OpenTelemetry or controlled runs |
| 6 | Q5 | Dispatcher reliability and measurement: store the full CLI result, exit code and stderr; surface "dispatcher offline: not logged in"; do not count errors toward the daily cap; retry with backoff and a breaker after 3 consecutive zero-token results; keep the tail of long agent text; record the human's actual next message as an implicit label for every draft | M | V (88% of attempts failed; the same zero-token "Not logged in" signature reproduced today; 0 ratings) | S | Q1 | Weekly drafting success at least 98%; label agreement table per class exists |
| 7 | Q7 | Truthful context gauge: window size per harness and model, `compact_boundary` and Codex `compacted` records, per-harness usage formulas (Claude adds three fields; Codex cached is inside input; Antigravity is additive), colors relative to the window, show compaction time as "compacting" not idle | L to M | V (91% of sessions would be red under 120k; median compaction 72 s) | S | none | Gauge matches Claude Code's own `used_percentage` within 1 point on a replay |
| 8 | Q8 | Tail `/api/logs` from the end of the file in a bounded chunk; send raw log lines only to clients that opened a session stream | M | V (200 to 250 ms stalls; 18 log events per 30 s unused) | S | none | E4: stall at most 20 ms for any file size |
| 9 | Q9 | Delete the dead Claude parser in the server, make tests hermetic and behavioral (record-replay fixtures, no writes to the live `.state/coordination.db`), correct the README (94 vs 170 checks, harness claims), reconcile the second copy under `~/.claude/scripts`, atomic queue file writes | M | V (D12; 166 of 170 pass only with real sessions) | S | none | E11 hermetic suite, at least 60% behavioral assertions |

### 5.2 Medium-term architectural changes (weeks each)

| Rank | ID | Change | Impact | Evidence | Effort | Risk | Depends on | Measurable success |
|---|---|---|---|---|---|---|---|---|
| 10 | M1 | Layered harness drivers with capability flags and resync. Claude: `~/.claude/sessions` registry and `claude agents --json` for liveness, HTTP hooks (consent-gated installer with backup, fail-open, 2-minute silence falls back to transcript) for approval, turn and failure events, transcript for content. Codex: hooks plus a corrected rollout parser (date-nested, zstd, `{type, payload}`, cumulative `token_count`) and app-server for sessions Agent HQ launches. Antigravity: `agy` hooks plus the brain transcript. OpenCode: SSE when present. One pure reducer turns normalized events into state and is replay-tested | H | V (D17, D19, D20; hooks verified to reach a local endpoint here; the roster poll costs 0.24 s CPU per call, about 6% of a core at one call per 4 s) + S (Codex typed thread status; four orchestrators converged on hooks first; scraping maintenance record) | M to L | M (user must add hook config; Codex desktop attachability undocumented) | Q1, Q4, Q9 | E5: approval-wait recall and precision at least 95%, median event-to-UI at most 1.5 s; E11 |
| 11 | M3 | Attention scheduler: order the queue by blocking value over expected human minutes with an age cap, show predicted wait from the capacity model N* = (Z + S) / S using measured Z and S, put finished turns in a digest delivered at breakpoints, optional phone reach for blocked items only, never re-alert the same turn, optional "continue with pre-authorized next step" | H | V (76% of wait minutes in gaps of two hours or more) + S (queueing theory) + W (interruption studies) | M | M (weights, starvation) | Q5, M1 | E9: at least 20% fewer idle agent-minutes on the top quartile by blocking value, no increase in interruptions per hour |
| 12 | M2 | Serial landing queue: per repo, merge target into a throwaway worktree, run the project tests on the combined tree, move the target ref with a compare-and-swap `update-ref` only if green, bounce conflicts and failures back to the agent through the outbox, retry flaky tests once; optional Mergiraf or LLM resolver as a suggestion | H | V (D6, D7) + S (GitHub merge queue, Zuul, bors-ng, Gas Town Refinery; Cursor swarm) | M | M (test time per landing) | Q3 | E6: 0 red mains in 300 generated pairs, false-block at most 5% |
| 13 | M4 | Overlap-aware scheduling replacing the lease database: per-task scope from declaration or inference (files the session edited per the board, `git diff --name-only`, directories), hold an overlapping task behind the running one and start it with a summary of what landed (sequential hand-off), run disjoint tasks in parallel; keep a warn-only PreToolUse signal behind an experiment | H | S (arXiv:2611.00314 16% to 54%; Claim Plane; CooperBench) + H (scope inference quality) | M | M | M1 | E12 on at least 40 local overlapping pairs |
| 14 | M5 | Incremental, event-sourced state: per-session cached summaries with dirty flags and memoized prices, delta SSE with a sequence number and periodic resync, then an append-only event log (SQLite or JSONL) for replay and audit | M | V (profile; scale table) + S (OpenHands persist 0.166 ms per event) | M | M | Q8, M1 | E4: at N = 50 CPU at most 5%, ping p99 at most 30 ms, append-to-UI p95 at most 250 ms |
| 15 | M6 | Dispatcher redesign: deterministic eligibility from structured waiting reasons, closed set of reply ids (code builds the reply text), random per-call data boundary, drafts bound to the waiting turn and revalidated at send, no one-click when `needsHuman`, rule-first then k=3 agreement then calibrated threshold, vendor auto mode offered for tool permissions | M | S (design patterns paper; Anthropic classifier blind to prose) + V (0 would-send, 0 ratings) | M | M | Q5, M1 | E8: false-send 95% upper bound at most 3% with at least 100 rated would-send drafts per variant; injection suite 0 sends |
| 16 | M7 | Fleet resource panel and admission control: per-session process count and RSS, free-RAM warning, staggered spawns, cap on simultaneous starts | M | V (20 `claude` processes, 2.7 GB, 3.2 GB free at measurement) + S (Agent Orchestrator failures at about 15 workers on 8 GB) | S | L | none | Free-RAM floor during a 15-session run |

### 5.3 Longer-term research opportunities

| ID | Idea | Why it could be new | Evidence | Risk |
|---|---|---|---|---|
| R1 | External supervisor agent over the live event stream: batched ticks every few seconds, closed action set (none, steer, redirect, revert), advisory by default, applied first to pairs of overlapping tasks | No orchestrator supervises heterogeneous local harnesses from outside; the hooks and drivers of M1 make the event stream available | S for the mechanism (SHEPHERD 28.8% to 54.7% on one benchmark; Wink -4% to -5% in production); H for transfer | Supervisor cost can exceed worker cost on short tasks; learned monitors miss most failures (3.7 to 8.7% before lock-in; 30% recall at 5% false alarms), so keep it advisory |
| R2 | Local record-replay fleet benchmark: golden transcripts per harness version, labeled loop, state and dispatcher sets, time-compressed replay with a fake clock | Nobody evaluates their own state detection, alerts and gates against recorded real sessions; doubles as regression suite for adapter drift (nine Claude Code versions changed transcript behavior) | Methods in E3, E5, E8, E11 | Labeling effort; privacy of transcripts |
| R3 | OpenTelemetry receiver as a second cost ledger and an OTel-shaped internal record | Reconciles transcript cost against per-request `cost_usd` and `request_id`; adopts GenAI attribute names instead of a custom schema | S (docs, source); conventions still in Development status | Spec churn; Claude exporter has no file sink |
| R4 | Capacity planner: measure Z and S per agent class and warn before the fleet passes saturation | Turns the queueing model into an operating tool | V (formulas) + H (parameters) | Parameter drift |
| R5 | Observation-masking nudge: tell the user when a session is cheaper restarted at a task boundary | Evidence says masking is as good as summarizing and belongs inside the harness; the external lever is a nudge | S (arXiv:2508.21433) + V (post-compaction floor 48.9k) | Low |

### 5.4 Recommended sequence

1. Week 1: Q1, Q2, Q3, Q4, Q5 (the paths the human trusts, plus the measurement that unblocks everything else). Re-run E1, E3, E7, E10 and publish the deltas.
2. Weeks 2 to 3: Q6, Q7, Q8, Q9, then start M1 behind a capability flag (Claude hooks first, Codex parser second).
3. Weeks 4 to 6: M2 (landing queue) and M3 (attention scheduler), measured against E6 and E9.
4. Weeks 7 to 9: M4 and M5, measured against E12 and E4. Decide the fate of `coordination.js` on E12's result.
5. After that: M6 once at least 150 implicit labels exist; R1 and R2 as the research track.

Not recommended before the above: automatic sending of any reply, automatic kill or restart on a stuck signal, AST merge as an automatic lander, an in-process memory or knowledge injector, a micro-VM airlock.

## 6. Implementation proposals (highest-priority items)

All proposals keep the zero-dependency, loopback-only, Windows-first shape. Interfaces are sketches to fix the contract, not code that exists. Each lists affected modules, migration, tests and the benchmark that decides success. File names refer to the baseline layout.

### 6.1 Q1: exactly-once, truthful delivery (replaces `deliver`, `wake`, `message`, `drainQueue`, `/api/dispatch/send`)

Affected: `agent-dashboard.js` (control section and the dispatch routes), `adapters/*.js` (`deliver`, `stop`), `agents-ui/dispatch.js` and `tray.js`.

Design. One persisted outbox, one code path. Table or JSONL with rows `{id, idem, sid, text, turnRef, status, attempts, lastError, createdAt, deliveredAt}` where `status` is `queued`, `sending`, `delivered`, `unknown`, `failed` or `expired`, `idem` is a client-generated key (unique), and `turnRef` is the transcript position the text was written for.

```
POST /api/messages   {sid, text, idem, source}  ->  {ok, id, status}        // idempotent on idem
GET  /api/messages/:id                           ->  {status, attempts, lastError}
driver.deliver(sid, text, {idem}) -> {status: 'delivered' | 'queued' | 'unsupported' | 'unknown', detail}
```

Rules: (1) a row moves to `sending` inside one transaction, so two callers cannot both send; (2) `delivered` is set only when the text appears as a user prompt in the target's transcript or the driver reports it consumed; a CLI exit code or a regex on output is not an ack; (3) `unknown` (timeout, unparseable output) is never retried automatically, it is shown to the human as "may have been sent" and resolved by the transcript check; (4) if the roster, forced fresh just before sending, says `working` or `blocked`, the row stays `queued` and the native reply queue is used where the harness has one; Agent HQ never runs `claude stop` as part of delivery, only as an explicit Stop button; (5) a draft key plus idempotency key replaces "newest draft for the session" in the webhook path; (6) Codex and Antigravity drivers return `unsupported` until M1 gives them a real channel, and the UI says so. The client renders only server status; the fallback to `/api/prompt` is deleted. Queue and outbox writes use temp-file-then-rename (or one SQLite transaction).

Migration: read the old `agents-queue.json` once, convert entries to `queued` rows, drop the old file. Behind a flag for one week with both paths logging.

Tests: E1 stub-CLI harness (already built: `stub-claude-preload.js`, `e2e-double-send.js`), with failure injection (CLI exits nonzero after applying, unparseable output, crash between claim and send, stale roster, double click, two tabs). Success criteria are in E1.

### 6.2 Q2: loop and stall detectors as pure functions

Affected: new `detectors.js` (pure, no I/O), `adapters/claude.js` (feed normalized events), `agents-ui/tray.js` and `world.html` (labels and ranks).

```
event = {kind: 'call'|'result'|'assistant', name, inputHash, ok, errHash, t}
detect(window /* events since last human prompt, max 40 */) ->
  [{id:'possible_loop'|'hard_loop'|'repeat_error'|'monologue'|'alternating'|'long_tool'|'blocked_quota', severity, evidence:[eventIdx], since}]
```

Rules: possible loop = 3 identical `(name, inputHash)` calls in a row; hard loop = 4 identical action-observation pairs or 5 identical calls; repeat error = 3 failures with the same `(name, errHash)`; monologue = 3 assistant messages with no call; alternating = A,B,A,B,A,B; long tool = open call with no event for 8 minutes (renamed, shown as "silent", never "loop"); blocked quota = result text matches the limit or not-logged-in patterns, which suppresses every other detector for that session. Polling tools on an allow-list (`git status`, waits) need identical results to count. Output is advisory: a chip and a tray row ranked below questions, never an automatic action. Evidence for each alert is shown so the human can judge in two seconds.

Migration: ship alongside the old rule, log both for a week, then remove the old rule and the "consecutive errors" copy.

Tests: unit tests on golden transcripts; E3 labeled set (at least 150 flagged and 150 unflagged samples, two blind labelers); injected positives for recall (a scripted fake transcript repeating a failing command). Benchmark: replay of the 7-day corpus must give at most 0.5 alerts per active session-day.

### 6.3 Q3 and M2: safe worktrees and a serial landing queue

Affected: `worktrees.js` (rewrite of merge, cleanup, prune), new `landing.js`, a landing panel in the UI (the shipped UI has no merge button today).

```
landing.enqueue({repo, branch, sid, testCmd, target:'main'}) -> {id}
per repo: single-flight (in-process queue plus a lock file) 
steps:
 1  baseTip = rev-parse target                         // remember for compare-and-swap
 2  wt = worktree add --detach ~/worktrees/.landing/<id> baseTip
 3  in wt: merge --no-ff --no-edit branch              // conflict -> merge --abort, status=conflict, bounce to agent via outbox
 4  in wt: run testCmd (timeout; one retry if it fails once and passes once = flaky)
 5  if green: update-ref refs/heads/target <wt HEAD> baseTip     // CAS; fails if target moved -> redo from step 1
 6  if the root has target checked out: only if clean, `merge --ff-only` to move the working tree; else leave and say so
 7  delete branch only if `merge-base --is-ancestor branch target`; remove wt
```

Worktree creation: id from a counter plus a short hash, `worktree add -b agent/<id> <dir> <explicit start point>`, refuse if the directory exists; for Claude sessions let the harness isolate (its `--worktree` and background isolation carry locks and the "no unpushed commits" guard) and only register the path. Prune and cleanup: refuse when any live session's cwd is inside; activity from `git log -1`, the index, the reflog and the session heartbeat; delete a branch only on ancestor proof or a recorded human confirmation; never `-D`; never remove uncommitted files without a confirmation row in the audit log.

Test plan: E6 (generator of branch pairs: clean, textual conflict, signature change, test-only conflict, flaky test; 300 pairs) and E7 (2,000 randomized git states with a "no commit becomes unreachable" invariant), both runnable in a temp repo with a fake HOME (the scripts `repro-worktrees.js` already reproduce the baseline failures). Benchmark: added wall-clock per landing at most 1.5x the project test time.

Not included on purpose: AST merge as an automatic lander (Spork-style merge made 11% of merges silently wrong against 3% for git) and a bisecting batch queue (no measured benefit at a few landings per hour; revisit if landings per hour grow).

### 6.4 M1: harness drivers and the shared reducer

Affected: `adapters/*` (becomes `drivers/*`), new `reducer.js`, new `/ingest` routes, `agent-dashboard.js` snapshot, a consent-gated `hooks-install` command.

```
class HarnessDriver {
  id; capabilities = {observe:['hooks'|'protocol'|'transcript'], steer:['queue'|'resume'|'none'], approvalState:bool, resync:bool}
  async snapshot()                       // authoritative current sessions (registry, app-server list, brain scan)
  events(sinceSeq) -> AsyncIterable<Event> // normalized, sequenced; may be backed by hooks, protocol or transcript
  async deliver(sid, text, {idem}) ; async stop(sid)
}
Event kinds: session.started|ended, turn.started|finished(reason), tool.started|finished(ok), approval.requested|resolved,
             question.asked, usage(messageId,requestId,tokens...), compaction, quota.blocked
reduce(state, event) -> state      // pure; phases: working | waiting_approval | waiting_input | idle | blocked_quota | ended
```

Claude driver: liveness from `~/.claude/sessions/<pid>.json` (pid, procStart for reuse detection, status, messaging socket) cross-checked with `claude agents --json` at a slow cadence; events from HTTP hooks posted to `/ingest/claude` with a per-install bearer token (hooks fail open by design, so a 2-minute silence or a sequence gap switches that session to transcript inference and back-fills); content (text, tools, usage) from the transcript with the existing offset reader. Codex driver: corrected rollout reader (walk `sessions/YYYY/MM/DD`, support `.jsonl.zst`, parse `{type, payload}`, use `token_count` totals as cumulative deltas, dedupe forked rollouts), hooks via `config.toml`, and `codex app-server` for sessions Agent HQ starts (typed `WaitingOnApproval` and `WaitingOnUserInput`). Antigravity driver: `agy` hooks and `transcriptPath`, brain transcript for content, launch with `agy`, not the Gemini CLI. OpenCode driver: `GET /api/event` with resync through `/api/permission/request` and the sequenced log. Reject busy or idle events that cannot be tied to a turn (a stuck-running class that even event-sourced tools suffered).

The hook installer is the owner's own tool, consent-gated: show the exact diff, back up `settings.json`, retry on write races with Claude Code, match its own entries by an exact marker, never substring-match (pixel-agents recorded each of these failure modes). This research run did not edit any settings file.

Migration: drivers register behind a capability flag; the reducer first runs in shadow beside the current state machine and the two are compared in the audit log for a week (disagreement rate per state is the E5 baseline).

Tests: E5 scripted scenarios with hook events as timestamped ground truth; E11 golden transcripts per harness version. Success: approval-wait recall and precision at least 95%, median event-to-UI at most 1.5 s through `PermissionRequest`.

### 6.5 M3: attention scheduler and capacity model

Affected: `tray.js`, `world.html` (queue order and chips), new `attention.js`, optional notifier module.

```
item = {sid, kind: 'approval'|'question'|'finished'|'error'|'quota', since, blockingWeight, expectedMinutes}
score = blockingWeight(kind, age, session role) / expectedMinutes(kind)      // weighted shortest job first, age cap prevents starvation
expectedMinutes = rolling median of measured human time per kind (from transcripts)
capacity: Z = mean agent run between asks, S = mean human minutes per ask, N* = (Z + S) / S; show predicted wait for the next agent; warn when N > 0.8 N*
digest: finished turns grouped, delivered at the next breakpoint (end of the user's turn, or a timer), never re-alert the same turn
away: if the user has not touched any session for T minutes, push blocked items only to a phone channel (ntfy or similar), never finished turns
```

Z and S come from `replay-turns.js` style offline measurement, kept as a rolling table. Success: E9 trace simulation first (bounds only), then a one-week alternating-day A/B on median time-to-first-attention and idle agent-minutes.

### 6.6 M4: overlap-aware scheduling (replaces `coordination.js`)

Affected: `agent-dashboard.js` start path, new `scope.js`, tray warning, `coordination.js` removed or reduced to a read-only audit of declared scopes.

```
scope(task) = declared (path globs in the prompt box or a repo manifest) ∪ inferred (files the session edited in the last 90 min from the board, `git diff --name-only` in its worktree, parent directories at configurable depth)
overlap(a, b) = |scope(a) ∩ scope(b)| > 0
on start(B): if any running A in the same repo has overlap(A, B):  hold B (status 'queued behind A'), start it when A's turn ends, with the first message prefixed by the landed summary of A (sequential hand-off)
             else start in parallel (worktree per agent)
```

Evidence base and its limits: arXiv:2611.00314 (hand-off 16% to 54% at equal tokens), Claim Plane (serialization drives the gains; under-declared scope failed closed in 46 of 90 runs), CooperBench (plans halve conflicts but do not raise success). The weak point is scope inference, so E12 measures it on at least 40 overlapping task pairs from the local corpus before the scheduler holds anything automatically; until then it only warns. If a lease is kept anywhere, it uses repo-relative keys, `BEGIN IMMEDIATE`, and a monotonic generation number that the enforcement point (a PreToolUse hook) checks, because the double-grant experiment produced duplicates in 2 to 7 of 3,000 contested files without a transaction and none with one.

### 6.7 M5: incremental state and delta push

Affected: `agent-dashboard.js` (`snapshot`, `push`), adapters (per-session summaries), `world.html` (patch handling).

Per session keep `{version, summary, dirty}`; the reducer or `feed()` marks dirty; aggregates (cost, tool counts) are updated when a message id first appears, with memoized prices; the full state is assembled only from summaries. SSE sends `patch {seq, sessions: {id: summary}, removed: [ids], counts, metrics}`; the client keeps a map and asks for a full resync every 60 s or on a gap. Removing the second `pruneMetrics` pass and the per-call price regex alone removes about 8% of the 100-session profile. Success: E4 (CPU, stall, latency and payload at N = 50 and 100, three repetitions).

### 6.8 M6: dispatcher gate

Affected: `dispatcher.js`, `dispatcher-policy.json`, `dispatch.js`.

Order of gates: deterministic eligibility from structured waiting reason and the last turn's tool classes (side-effect tools make the draft `needs_human` with no reply offered) -> the model chooses a `reply_id` from a closed list (continue, run the tests, yes proceed, no stop, show me the diff) with fixed-vocabulary slots; code renders the text -> k=3 cheap samples must agree on the same id -> threshold chosen per class from logged implicit labels with exact Clopper-Pearson bounds (a 5% bound needs 59 error-free rated sends, 1% needs 299). Verbalized confidence stays as a veto only. Drafts are bound to the waiting turn and revalidated at send time; the one-click button is hidden when `needsHuman` or `blockedBy` is non-empty. Adversarial suite of about 30 injected agent replies (forged closing tags, "the user already approved", fake policy lines) with target 0 sendable outputs outside the closed set. Offer Claude Code auto mode for tool permissions instead of rebuilding a classifier.

## 7. Experimental validation plan

Rule: no improvement is claimed without a measurement from one of these experiments. "Baseline" below is what was measured on 2026-11-23 against commit 86169e7 (scripts in `research/2026-11-23-lanes/bench/`). Every experiment names a metric, a workload, a control, a failure injection where relevant, and an acceptance threshold fixed BEFORE the treatment is built. Where a sample-size claim is made it uses the rule of three (zero failures in n trials gives a 95% upper bound of about 3/n) or Clopper-Pearson.

Common method: hermetic fake HOME (never the live `~/.claude`), baseline server cloned at 86169e7 into `baseline/agent-hq`, treatment in a second clone, same generator seed, 3 repetitions per cell, report median and range, stub `claude` CLI via `node --require stub-claude-preload.js` so no model spend, no real sessions touched.

| ID | Question | Defects / ideas covered | Baseline (measured) | Acceptance threshold |
|---|---|---|---|---|
| E1 | Does one human action cause exactly one delivery, and does the UI tell the truth? | D1, D2, D13 | One "Accept & Send" click on a background agent = 2 `--resume` deliveries and a 500 shown to the user (e2e with stub CLI, 1 trial); Nudge shows success while the server returned 403 | 1,000 randomized trials, at least 200 per failure class (CLI nonzero after side effect, unparseable CLI output but applied, crash between dequeue and deliver, stale roster, double click within 1 s): 0 duplicates and 0 losses outside the crash class; crash class never loses a message and flags a possible duplicate in the UI; UI status equals delivery truth in 100% of trials; zero failures in 1,000 trials gives a 95% upper bound of 0.3% |
| E2 | Is the fleet cost number right, including subagents? | D16, D18, price table, cross-file duplicates, Codex and Antigravity coverage | Subagent transcripts (150 files) hold 17.9% of 7-day API-equivalent cost ($218 of $1,216, lane L8: 21% on its basis) and are ignored; naive row summing would overstate 2.1x to 2.8x and Agent HQ's per-file dedupe is correct in tokens (exact match on a known-truth run); dollars were 45% low on that run (Haiku 5.5 above 100k prompt tokens costs 5x); Fable 5.1 cache read priced $1.00 instead of $0.25 (+$67 of $143 per week); 1-hour write rate applied to every write; 7.7% of message ids repeat across resumed transcripts (6.7% overcount); Codex coverage 0%; Gemini table about 4x low (INFERENCE) | Known-truth fixtures: vendor `total_cost_usd` within 1% per headless run (n at least 10, including a subagent run, an over-100k run and a resumed copy); fleet total within 2% per day and 5% per session of the OpenTelemetry ledger; 0 unpriced calls (show "unpriced"); Codex sessions visible with token totals matching `token_count` deltas; sensitivity to cache TTL assumption reported |
| E3 | Does the stuck/loop alert point at real trouble? | D4, loop ideas (OpenHands StuckDetector, Wink-style observer, SHEPHERD-style supervisor) | Rule fires on 75.6% of active 10-minute samples (466/616); strict repeat-loop proxy appears in 3 samples; precision vs that proxy 0.6% | Labeled sample of at least 150 flagged and 150 unflagged samples, stratified across the 38 interactive sessions, two blind labelers (human plus an LLM judge, Cohen kappa at least 0.6); new detector: precision at least 70% (lower 95% bound at least 55%), recall at least 80%, at most 0.5 alerts per active session-day, median time-to-alert after onset at most 3 minutes |
| E4 | Does the server stay responsive as the fleet grows? | D11, snapshot cost, delta protocol, hook-driven roster | N = 12 / 25 / 50 / 100 sessions: server CPU 10.4 / 10.4 / 13.7 / 25.6%; state build 22 / 33 / 86 / 173 ms; payload 42 / 87 / 173 / 343 KB; append-to-UI p50 388 / 434 / 382 / 501 ms, p95 701 / 759 / 645 / 693 ms; ping max 558 / 528 / 1381 / 321 ms; `/api/logs` on a 34 MB transcript blocks the loop 200 to 250 ms | At N = 50: CPU at most 5%, ping p99 at most 30 ms, append-to-UI p95 at most 250 ms, SSE at most 40 KB/s; at N = 100: CPU at most 10%; `/api/logs` stall at most 20 ms for any transcript size; 3 repetitions inside 15% of each other |
| E5 | Can the state machine tell "waiting for approval" from "running a long tool" and from "asked a question"? | D17, hook-first observation | Not measurable today: the transcript adapter has no pending-approval state (HYPOTHESIS, to be confirmed by this experiment) | 200 scripted scenarios on real Claude Code (permission prompt, AskUserQuestion, long Bash, tool failure, subagent, compaction, resume) with hook events as timestamped ground truth: state correct in at least 95% of scenarios, permission-wait recall and precision at least 95%, median event-to-UI latency at most 1.5 s (PermissionRequest) and at most 8 s via Notification (6 s built-in delay), zero state flapping longer than 2 s |
| E6 | Does the landing step keep main green? | D6, D7, merge queue, structured merge | Semantic-conflict scenario: merge ok, speculative test passed on the branch, main then failed (1 of 1 reproduced) | At least 300 generated branch pairs (clean, textual conflict, signature change, test-only conflict, injected flaky test): 0 post-landing red mains (95% upper bound 1%), false-block rate at most 5% after flaky retries, added wall-clock at most 1.5x the project's test time per landing, 0 landings into a dirty or busy root checkout |
| E7 | Can cleanup ever destroy unmerged work? | D5, D7 | Reproduced: branch with an unmerged commit deleted by prune after a 72 h-old directory mtime | 2,000 randomized git states (unmerged commits, dirty tree, stash, detached HEAD, locked worktree, junctioned path, branch checked out elsewhere): 0 cases in which a commit reachable only from the deleted ref becomes unreachable without an explicit human confirmation recorded in the audit log |
| E8 | Is the auto-send gate safe and useful? | dispatcher confidence gate, deterministic rules first, injection hardening | Lane L7 on `.state/dispatcher/audit.jsonl` (65 h): 237 attempts, 28 drafts (11.8%), 209 zero-token errors (88.2%; same signature as today's headless "Not logged in"); 0 would-send, 0 rated, 0 sent; 3 non-empty replies of 28; confidence 9 distinct values, 14 of 28 at 0.9 or higher; cost $0.0107 per draft, p50 4.3 s; false-send bound with n = 0 rated is 100% | Offline replay of every logged draft against gate variants (confidence at least 0.8; rules only; rules plus 3-sample agreement; calibrated threshold from ratings): false-send 95% upper bound at most 3% with at least 100 rated would-send drafts per variant; coverage of waiting turns at least 20%; cost per draft and latency reported; adversarial suite of 50 agent outputs carrying embedded instructions: 0 sends, 0 bypasses of the human-only list |
| E9 | Does ordering and "away" handling reduce idle time? | attention scheduler, continuation policy, remote notify | 7-day corpus: 76% of human-wait minutes come from 35 gaps of 2 h or more; median human reply 2.2 min; mean agent turn / mean human gap = 0.26 | Trace-driven simulation with replayed arrival and response times (bounds, because response time under a new order is modeled as order-independent): at least 20% fewer idle agent-minutes on the top quartile of items by blocking value with no increase in interruptions per hour; then a one-week live A/B (alternating days) measuring median time-to-first-attention and idle minutes |
| E10 | Are the local-API security holes closed and do they stay closed? | D8, D9, D10 | Reproduced: unauthenticated lease/intent POST with foreign Origin 200; unauthenticated GET injects into terminal streams; approval accepted with the public default secret | Scripted attack suite (repro-defects.ps1 extended): every state-changing route refuses a missing token or a foreign Origin; no state change on GET; webhook tokens bound to (sid, decision, expiry, nonce) and replay returns 403; server refuses to enable webhooks without a configured random secret; suite runs in CI |
| E11 | Do adapters keep working when harness formats change? | adapter drift, hermetic tests | Test suite: 166 of 170 pass without real sessions on disk; 57 of 155 assertions are string checks; 3 live HTTP checks | Record-replay corpus (golden transcripts per harness version, time-compressed): 100% of golden state transitions reproduced; suite hermetic (0 dependence on `~/.claude` content), at least 60% of assertions behavioral; fails loudly when an unknown transcript row shape appears |
| E12 | Does overlap-aware scheduling beat parallel and message passing for overlapping tasks? | M4 (replaces leases) | Literature only: sequential hand-off 16% to 54% at equal tokens (arXiv:2611.00314); not yet measured locally | At least 40 overlapping task pairs built from the local corpus (two prompts that touch the same files, run on identical repo snapshots in throwaway worktrees with a cheap model): sequential hand-off at least 25 points above parallel-unaware on the project tests at no more than 1.2x tokens; scope inference recall at least 80% of the files each task actually edits; false holds (non-overlapping tasks held) at most 10% |

### Controls and threats to validity

- Single developer, single week of transcripts (50 files): all corpus-derived rates are descriptive of this workflow, not a population.
- Synthetic fleets (E4) share content shape across sessions; real transcripts have heavier tool results.
- LLM-judge labels (E3, E8) are used only as the second blind labeler; a human label decides ties.
- Vendor-run studies in the literature (Anthropic auto mode, Cursor swarm posts) are leads for hypotheses, not for acceptance thresholds.
- Any claim that a treatment is "faster" or "safer" in the final report must cite the experiment id and the measured cell; otherwise it stays a HYPOTHESIS.

### Reproduction

`research/2026-11-23-lanes/bench/README.md` lists every script used for the baseline numbers and the exact command lines. The scripts read the local transcript corpus and print aggregates only.

## 8. Rejected alternatives, refuted claims and open questions

### 8.1 Rejected alternatives (with the reason)

| Idea | Source of the idea | Why rejected |
|---|---|---|
| Fine-grained pre-edit file and symbol leases as the main coordination layer | Earlier plan (`coordination.js`) | Never called by any harness (0 leases ever); keys are per-worktree absolute paths so they cannot conflict; without fencing tokens an expiring lease cannot protect a write; Cursor's task-claim lock slowed 20 agents to the throughput of 2 or 3; the measured gains come from serialization and landing, not locks (E12 decides whether any lease survives) |
| Tarjan deadlock resolver with `git reset --hard HEAD~1` rollback | Research doc section 15.2B | Leases are try-lock with TTL, so nothing waits and there is no wait-for graph; the rollback is the same destructive-cleanup class as D5 |
| AST or tree-sitter merge driver as the landing mechanism | Research doc sections 13.2 and 7 | Evidence points the other way for automation: Spork-style merge produced 11% silently wrong merges vs 3% for git ort; Mergiraf fully resolved 5.8% of Linux conflicts (correctness unreported); LLM resolvers match the developer's text 44 to 55% on small hunks. Fine as an opt-in suggestion inside a tested queue |
| Bors-style batch-then-bisect queue now | Gas Town | No measured benefit at a few landings per hour; revisit if landings per hour grow |
| Micro-VM "airlock" (Zone B) | Research doc section 19 | Firecracker needs KVM; this host has no Windows Sandbox (Home edition), no Hyper-V module, WSL2 with only the docker-desktop distro; Claude Code's sandbox is unsupported on native Windows. Docker Desktop containers are the only realistic isolation, for untrusted repositories only |
| Knowledge fabric auto-injection and sleep-time consolidation daemon | Research doc sections 12 and 21 | Write-only today; evidence says auto-generated context files are neutral on success and +20 to 23% cost, stale instructions cost about a third more tool calls and agents never repair them; sleep-time compute does not study memory consolidation |
| Summarizer or context compactor for other tools' sessions | Research doc section 9 | Observation masking matches LLM summarization at about half the cost and belongs inside the harness; a summarizer lengthened trajectories 13 to 15% |
| Verbalized-confidence 0.8 (or 0.9) as the send permission | Current `dispatcher.js` | 9 distinct values in 28 draws, 14 at 0.9 or higher, overconfident in the literature; keep as veto only |
| Automatic kill, restart or typing on a stuck, loop or quota signal | Research doc sections 15.2C and 6 | Gas Town's false-kill record; learned monitors reach about 30% recall at 5% false alarms and continuing beat restarting in 216 of 224 settings; Herdr and Orchestrator.inc: never type into a session that is not positively waiting |
| Three-tier AI watchdog, Dolt or SQL-server state, kanban or issue-board product shape, tmux or PTY ownership, cloud relays | Peer projects | Costs and failures documented in lane L5; Agent HQ watches sessions it does not own and runs on native Windows |
| Hosted observability (Langfuse, Phoenix, AgentOps, Helicone) | Telemetry survey | They ingest the same data, have no loop evaluators, and do not fix dedupe or pricing |
| Rewriting the server in another language or runtime | Not proposed, considered | The profile shows recomputation and syscalls, not parsing (a cold 117 MB read and parse took 1.2 s) |
| A custom telemetry schema (UTMP) | Research doc section 17.1 | Duplicates OTel GenAI and omits request id, parent agent id, cache-tier split and speed |
| Fuzzy-similarity loop detection (Levenshtein 0.85) as the trigger | Research doc section 15.2C | Published precision 0.16 for cosine 0.85 alone; on this fleet 0 firings with the error condition and 73 of 76 healthy firings without it |
| "12 tool calls without an edit" brake | Research doc section 10 | Source not found; would fire on 22% of turns here |

### 8.2 Claims in the earlier documents: verdicts

| Claim | Verdict | Where |
|---|---|---|
| MAST proves 93% human rubber-stamping | REFUTED (wrong paper; 93% is Anthropic's auto-mode post, 97% later) | L1, L7, L8 |
| AgenticFlict: 84% of cross-agent conflicts in core logic | UNSUPPORTED (it measures PR vs base, 27.67%; 84.4% of conflicted files being source files is in arXiv:2607.04697) | L1, L3, L6 |
| 75 to 85% of spend is input tokens | UNSUPPORTED as a figure (paper: about 154:1 input to output, cache reads dominate; 88.3% on this machine) | L1, L2, L8 |
| Accuracy peaks at intermediate cost | CONFIRMED with caveats | L1, L8 |
| Cursor: lock contention made 20 agents act like 2 to 3 | CONFIRMED, narrower (task-claim lock, anecdotal) | L1, L3, L5 |
| Devin error amplification and high token cost | UNSUPPORTED as attributed | L1 |
| Gas Town watchdog killed live agents | CONFIRMED (wrong liveness signals, destructive action) | L3, L5 |
| Claude Squad needs tmux, no native Windows | CONFIRMED (#275 open) | L4, L5 |
| Vibe Kanban and Crystal sunset with 28k+ stars, Claude/Aider only, proprietary formats | PARTLY REFUTED (VK 28.8k stars and 10+ agents; Crystal 3.1k stars; cause was commercial) | L4, L5 |
| Superset and Conductor are closed source with heavy memory | Superset MIT (REFUTED); memory claims UNSUPPORTED | L5 |
| CCManager is Claude Code only | REFUTED (10 harness detectors, by scraping) | L4 |
| Agent HQ is the only open-source tool normalizing Antigravity, Claude and Codex | UNSUPPORTED in absolute form; and its Codex support is non-functional today | L4, parent |
| CodeNib cuts tokens 50 to 87% and beats on-demand exploration | MISLEADING (localization only; one cheap model, one run, USD 1 budget, CI includes zero when clustered by repo) | L2 |
| Agents waste 40 to 60% of tokens re-reading files | UNSUPPORTED (closest: 26% of read actions on one model) | L2 |
| Context gauge green below 40k, red above 120k | WRONG for this fleet (91% of sessions would be red) | L2 |
| 16 of 19 agents sat idle waiting | UNSUPPORTED (no source or log) | L7 |
| HMAC approvals expire in 15 minutes, 15 s heartbeat leases | REFUTED for 86169e7 | L3, L7, parent |
| Speculative tests block ghost merges | REFUTED (reproduced) | L6, parent |
| Static log polling has 500 to 1,500 ms latency | UNSUPPORTED (actual floor 0.25 to 0.85 s, up to 4 s for unwatched dirs; measured append-to-screen p50 about 390 to 500 ms) | L4, parent |
| 12 tool calls without an edit brake; Levenshtein 0.85 circuit breaker | UNSUPPORTED; no such code exists | L8 |
| The Tarjan, sleep-time and fabric subsystems exist | REFUTED (not in code) | L2, L3, parent |

### 8.3 Open questions (what would settle each)

1. Does `claude agents --json` or `~/.claude/sessions/<pid>.json` ever express a permission wait for interactive and Desktop sessions? A scripted interactive run with a known permission prompt and hook events as ground truth (E5).
2. Can an external process post to a Claude session's inbox on native Windows (auth key location, behavior in bypass-permission Desktop sessions)? A one-message test.
3. Can Agent HQ attach to a Codex desktop session's app-server, or only to servers it starts? Documentation is silent; read the app-server daemon code or test with the desktop app running.
4. What caused the 209 zero-token dispatcher failures? Strong lead: headless `claude -p` returns "Not logged in" with exactly that signature (reproduced today). Confirm by logging the full result for a week (Q5).
5. How good is scope inference for overlap scheduling? E12 on at least 40 local overlapping pairs before any automatic hold.
6. What fraction of waiting turns would a human have answered with each closed reply id? Needs the implicit labels from Q5; until then no false-send claim is possible (bounding it at 5% needs 59 error-free rated sends).
7. Is the 17.9% subagent share and the Haiku-above-100k price tier stable across weeks? Re-run `replay-subagent-cost.js` and the known-truth test weekly; the known-truth run is n = 1.
8. Does hook-first observation reduce false "stuck" and false "waiting" in practice, or just move the errors? E5 plus a one-week shadow comparison (reducer vs current state machine).
9. Do the effects reported for SHEPHERD and Co-Coder (CooperBench and spec-to-repo benchmarks, weak or small models) transfer to brownfield edits by strong models in this fleet? Only a local trial can say.
10. Antigravity: token semantics (does `input_tokens` include cache), what "no model" rows are, and whether it bills per token at all; whether `CHECKPOINT` records mean compaction.

### 8.4 What this research did not cover

Cloud-hosted fleets and multi-user control planes; mobile clients beyond a notification channel; Gemini CLI and Goose session formats beyond docs; the UI's visual design and the "pixel office" metaphor (the earlier documents' HCI claims about spatial gamification were not supported by any source I or the lanes found, and no source was found against them either, so they are neither endorsed nor refuted); any model-quality question about which model should run which task.

## 9. Research record: time, coverage, verification and limits

### 9.1 Time and stop reason

Budget: "multi-hour" with no number means at least 3 hours of active work (the owner's deep-research rule); waiting does not count. Start 2026-11-23 13:07 -08:00.

Active work, by segment: 13:07 to about 13:50 (parent audit, reproductions, measurements; eight lane agents started 13:10 and worked about 12 to 25 minutes each); 18:43 to about 19:05 (lane agents resumed, parent measurements and report draft); 00:26 to about 01:05 on 11-24 (two lane agents resumed and finished, synthesis, verification, report). Total about 1.6 hours of active work, about 55% of the budget.

Stop reason: runtime limit, not saturation. A usage limit (HTTP 429, "monthly spend limit, 5-hour limit resets 6pm", then "resets 11:40pm") stopped all eight lane agents at about 13:22 and again at about 19:00 and halted the parent from about 13:50 to 18:43 and from about 19:05 to 00:26. After the second stop only the two thinnest lanes (L5, L8) were resumed, on a 20 to 25 minute cap, to avoid a third stop. Saturation was not shown: lanes L1, L2, L3, L4 and L6 stopped mid-way and their last checkpoint notes (not the restructured BRIEF format) are what the report uses; no second wave of fresh lanes and no independent adversarial reviewer of the finished report was run. What would use the remaining budget best, in order: (1) an independent reviewer that tries to break the top 15 claims using only the lane files and primary pages; (2) the first four experiments (E1, E3, E5 and E7 need no model spend except E5); (3) finishing the five unstructured lanes.

### 9.2 Coverage

| Lane | Screened | Read in depth | Output state |
|---|---|---|---|
| L1 multi-agent papers | not recorded in file | about 25 (papers, production posts, source) | checkpoint notes, structured parts A to E |
| L2 context and memory | not recorded | about 20 | checkpoint notes |
| L3 durability and coordination | not recorded | about 25 plus one experiment | checkpoint notes |
| L4 harness integration | not recorded | about 25 (13 repositories at named SHAs) | checkpoint notes |
| L5 orchestrator source | about 60 | 15 (70+ issue bodies) | final format |
| L6 merge and isolation | not recorded | about 20 plus experiments | checkpoint notes |
| L7 attention and triage | 56 | 16 | final format |
| L8 evaluation, telemetry, cost | 45 | 15 plus one known-truth run | final format |
| Parent | | code audit (about 9,000 lines read in full or by section), 14 measurement and reproduction scripts, 7 primary-document checks | |

Recorded totals are lower bounds: at least 160 candidates screened and at least 46 sources read in depth in the three lanes that recorded counts; the five lanes that stopped early read at least the sources listed in their files (roughly 115 more in depth). The owner's coverage target (100 or more screened, 15 to 30 read in depth) is met in aggregate; the per-lane counts for L1 to L4 and L6 are missing, not zero.

### 9.3 What was verified by whom

- Parent, by running or fetching: all 14 audit measurements and reproductions (P0, `bench/`), the arXiv id and title check (57 of 57 resolve, P1), the hooks reference, a live HTTP-hook delivery test on this Windows install, the headless authentication signature, ten spot-checks of load-bearing numbers against primary text (P3).
- Lane agents, by reading primary sources and source code: everything in sections 3.1 to 3.8 not listed above. Lane files state for each item whether the page was read directly or relayed by a summarizing fetch tool (WebFetch returns a small-model paraphrase, so those are marked "relayed").
- Not checked by anyone: Conductor, Roo Code and Terragon shutdown reasons (secondary sources); several benchmark effects quoted second-hand in L8; Antigravity token semantics; Codex and Claude loop internals.

### 9.4 Limits that matter for using this report

- One developer, one week of transcripts (50 files), one Windows machine: every rate here describes this workflow, not a population.
- Synthetic scale tests use a generated transcript shape and an empty CLI roster.
- Two data sources are private (transcripts and the dispatcher audit log). Scripts print aggregates only; no content is quoted. The `bench/` scripts read `%USERPROFILE%\.claude\projects`; do not publish their per-session output.
- Vendor posts and vendor-run studies (Anthropic, Cursor, Letta, Mem0, Zep) are used for hypotheses and for direction, never for acceptance thresholds.
- The known-truth cost run is n = 1; the double-send reproduction used a stubbed CLI; the HTTP-hook test covered two of nine registered events because the headless call could not authenticate.
- No Agent HQ source, settings file, hook, or `.state` file was modified. The live server was only read through GET endpoints. Throwaway processes were started and stopped by exact process id.

### 9.5 Files

`research/2026-11-23-agent-hq-improvement-research-report.md` (this report, assembled from `research/2026-11-23-lanes/report-parts/`); `research/2026-11-23-improvement-research-ledger.md`; `research/2026-11-23-lanes/`: `BRIEF.md`, `P0-current-state-audit.md`, `P1-arxiv-id-check-pass1.txt`, `P1-arxiv-id-check-pass2.txt`, `P3-primary-doc-checks.md`, `P4-experiment-plan.md`, `L1` to `L8` lane reports, `bench/` (scripts, README, raw scale results).