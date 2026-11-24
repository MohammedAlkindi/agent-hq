# Agent HQ improvement research: ledger

Resumable run record. Deliverable: `research/2026-11-23-agent-hq-improvement-research-report.md`. Evidence: `research/2026-11-23-lanes/`.

## Question

How should Agent HQ improve (architecture, performance, reliability, scalability, orchestration, capabilities), judged by a source-level audit of the current code and by primary sources: papers, production agent harnesses, benchmarks. No code changes during research; commit 86169e7 (main) is the baseline.

## Budget and clock

- Trigger: "multi-hour" with no number means at least 3 hours of active work (DEEP-RESEARCH.md). Waiting does not count.
- Start 2026-11-23 13:07 -08:00. Keep-awake requested (session_idle).
- Active work: 13:07 to about 13:50; 18:43 to about 19:05; 00:26 to about 01:10 on 11-24. About 1.6 hours, about 55% of budget.
- Interruptions: a usage limit (HTTP 429, resets 6pm, then 11:40pm PT) stopped all eight lane agents at about 13:22 and about 19:00. Resumed all eight at 18:44; resumed only L5 and L8 at 00:27 (20 to 25 minute cap) to avoid a third stop.
- Stop reason: RUNTIME LIMIT (usage quota), not saturation. Unspent budget about 1.4 hours. Recommended use of it is in report section 9.1.

## Waves

| Wave | Time | Scope | Output |
|---|---|---|---|
| 0 | 13:07 to 13:50 | locate repo, read prior research and all core code, reproduce defects, measure baseline (parent) | P0 audit, `bench/` |
| 1 | 13:10 to 13:22, resumed 18:44 to about 19:00, L5 and L8 00:27 to 00:32 | eight lane agents L1 to L8 (BRIEF.md) | L1 to L8 lane files |
| 2 (parent) | 18:43 to 19:05; 00:26 to 01:10 | replay and scale experiments, primary-document checks, arXiv id checks (57 of 57 resolve), ten spot-checks, synthesis | P1, P3, P4, report |

## Sources

Per-lane source lists with URLs, commit SHAs and file paths are in the lane files. Recorded counts: L5 about 60 screened and 15 deep; L7 56 and 16; L8 45 and 15; L1, L2, L3, L4, L6 did not record counts (each read roughly 20 to 25 in depth). Parent: 7 primary-document checks, 57 arXiv ids cross-checked, 10 numbers spot-checked against primary text.

## Findings (index; full text in the report)

1. Core sound and cheap; headline claims overstated. Codex adapter sees 0 of 11 Codex sessions; Codex and Antigravity deliver/stop are no-ops reporting success; dispatcher 88% failed, 0 rated, 0 would-send; leases never used.
2. Reproduced defects: one-click send double-delivers (e2e, stub CLI); Nudge silently refused; Revert dead; loop alarm 75.6% of active samples vs 0.6% proxy precision; prune deletes unmerged branches; speculative tests miss ghost merges; merge runs in the user's checkout and leaves MERGE_HEAD; unauthenticated coordination and injection routes; public default webhook secret; cross-process lease double grants.
3. Earlier research claims: 93% and MAST refuted; AgenticFlict mis-described (27.67% PR vs base); 75 to 85% input figure absent; CodeNib over-generalized; sleep-time, Tarjan, fabric, HMAC expiry not in code.
4. Evidence points to: serialize overlapping tasks, tested serial landing, external supervisor ticks; against fine leases and AST auto-merge.
5. Wait minutes: 76% in 35 gaps of 2 h or more (7-day corpus).
6. Official surfaces exist: 33 Claude hook events incl. HTTP hooks (delivery verified here), `claude agents --json`, `~/.claude/sessions`, Codex app-server typed waiting states, OpenCode SSE with resync, Antigravity hooks.
7. Cost panel errors in both directions: price tiers, cache TTL, subagents (17.9% to 21% missing), cross-file duplicates (6.7%), Codex 0%.

## Rejected alternatives and open questions

Report section 8 (14 rejected ideas, 22 claim verdicts, 10 open questions).

## Stop reason

Runtime limit (usage quota) after about 1.6 of 3 active hours; see Budget and clock.
