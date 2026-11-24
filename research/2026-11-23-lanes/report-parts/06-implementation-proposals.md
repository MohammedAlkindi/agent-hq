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
