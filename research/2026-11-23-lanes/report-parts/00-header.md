# Agent HQ: evidence-backed improvement research report

Date: 2026-11-23 to 2026-11-24. Baseline: commit 86169e7 (main), unchanged. No Agent HQ source was edited; only files under `research/` were written (reports, notes and measurement scripts). Throwaway clones and fake home directories under the session scratchpad were used for every experiment that ran code.

Implementation status (2026-11-24): roadmap items Q1 to Q5 are implemented and merged to local `main` in the commit titled "fix: week 1 fixes for delivery, loop alarm, worktrees, API and dispatcher" (not pushed); details, before and after table and limits are in `research/2026-11-23-lanes/P5-week1-fixes.md`. Everything else in section 5 is not started. Sections 2 and 3 describe the code as it was at 86169e7.

How to read this. Every finding carries one of three tags. VERIFIED: the primary source or code was read, or the measurement or reproduction was run, on this machine or by a named lane agent (lane files record which). INFERENCE: reasoned from verified facts. HYPOTHESIS: untested. Where a number was relayed by a summarizing fetch tool rather than read in the page, the lane file says so and the report marks it "relayed". All counts of sessions, tokens and dollars come from scripts in `research/2026-11-23-lanes/bench/` that print aggregates only; no transcript content is quoted anywhere.

Contents: 1 Executive summary; 2 Current-state architecture audit; 3 Research and repository review; 4 Comparative architecture analysis; 5 Prioritized roadmap; 6 Implementation proposals; 7 Experimental validation plan; 8 Rejected alternatives, refuted claims, open questions; 9 Research record (time, coverage, limits, files).

Where the evidence lives: `research/2026-11-23-improvement-research-ledger.md` (clock, waves, stop reason); `research/2026-11-23-lanes/` holds the parent audit (`P0`), primary-document checks (`P3`), the experiment plan (`P4`), the arXiv id cross-check (`P1`), eight lane reports (`L1` to `L8`) with source lists and commit SHAs, and `bench/` with every script behind a number.
