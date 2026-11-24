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
