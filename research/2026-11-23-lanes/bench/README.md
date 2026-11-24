# Baseline measurement scripts (2026-11-23, Agent HQ commit 86169e7)

Nothing here changes Agent HQ. Every script runs against a throwaway clone with a fake HOME, or reads local data and prints aggregates only.

Setup (once): choose a scratch folder S (any empty folder). `git clone <agent-hq repo> S/baseline/agent-hq` and check out 86169e7. Copy the scripts into S. Scripts take S as an argument or assume they sit in S.

| Script | What it measures | Run |
|---|---|---|
| repro-defects.ps1 | D1 to D3 and D8 to D10: sentText error, missing-token Nudge/Revert, unauthenticated coordination and injection routes, default webhook secret | `pwsh S/repro-defects.ps1` (starts a clone server on port 7799 with fake HOME, stops it by pid) |
| repro-wake.ps1 | attempt to reproduce the dead `wake()` lookup (inconclusive under a fake HOME: no roster) | same |
| repro-worktrees.js | D5 prune deletes an unmerged branch; D6 speculative tests pass on the branch while main breaks after merge | `node repro-worktrees.js S` |
| stub-claude-preload.js + e2e-double-send.js | D1 end to end: one click = two deliveries, using a stubbed `claude` CLI via `node --require` | `node e2e-double-send.js S` |
| replay-loop.js | D4: loop rule over 7 days of local transcripts vs a strict repeat-loop proxy | `USERPROFILE=<real home> node replay-loop.js 7` |
| replay-cost.js | naive vs deduped usage; confirms the message-id dedupe | `node replay-cost.js 7` |
| replay-subagent-cost.js | D18: cost held in subagent transcripts vs main transcripts, using Agent HQ's own price table (needs `baseline/agent-hq` next to the script) | `node replay-subagent-cost.js 7` |
| replay-turns.js | agent turn length, human reply gaps, wait-time share by gap size | `node replay-turns.js 7` |
| bench-scale.js | server CPU, state build time, payload, append-to-UI latency and event-loop stalls for N synthetic sessions | `node bench-scale.js S 50 8 40 7822 2048` (sessions, writers, seconds, port, KB per file) |
| profile-snapshot.js + analyze-cpuprofile.js | CPU profile of `snapshot()` on a synthetic fleet | `node --cpu-prof --cpu-prof-dir=P profile-snapshot.js <bench-home>` then `node analyze-cpuprofile.js P/<file>.cpuprofile` |
| watch-test2.js | fs.watch(recursive) behavior with cross-process writes | `node watch-test2.js S` |
| verify-arxiv.js | cross-check every arXiv id cited in lane files against the arXiv API (titles, dates) | `node verify-arxiv.js <lanes dir>` |

baseline-bench-scale-results.jsonl holds the raw output of the 12 / 25 / 50 / 100 session runs reported in P0 section 6.2.

The transcript-reading scripts (replay-*.js) read `%USERPROFILE%\.claude\projects` and print only counts and distributions. Do not paste their per-session output anywhere public.
