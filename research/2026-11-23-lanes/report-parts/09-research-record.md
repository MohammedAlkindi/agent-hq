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
