# Bootstrap graph topology: tickets

Specification: [spec.md](spec.md). Design contract: `GRAPH-SPEC.md`. Vocabulary: `GLOSSARY.md`. Architecture: `docs/adr/0001-agents-drive-graph-execution.md`. Tracker: local files. Prepared 2026-11-18.

Tracks: widget 03→04; loops 05→06→07/08/09; graph 12→13. They meet at 14. 01 and 02 are prefactors.

**Implementation status (2026-11-18):** Tickets 01–13 and 15 are implemented and merged on `main`. Verified acceptance criteria are checked, and each ticket lists the reasons for any unchecked criteria. The review-and-fix rounds for settlement, cancel and joins have landed on `main`. Tickets 14, 16 and 17 are not yet merged.

| # | Ticket | Blocked by |
| --- | --- | --- |
| 01 | [Generalise the run fixture to N nodes with simulated tab close](issues/01-generalise-the-run-fixture-to-n-nodes-with-simulated-tab-close.md) | None |
| 02 | [Represent every plan internally as nodes with inbound edges](issues/02-represent-every-plan-internally-as-nodes-with-inbound-edges.md) | None |
| 03 | [Draw the planned graph in the dry run (chain, team)](issues/03-draw-the-planned-graph-in-the-dry-run.md) | 02 |
| 04 | [Live graph widget for chain and team runs](issues/04-live-graph-widget-for-chain-and-team-runs.md) | 03 |
| 05 | [Plan and validate decisions and limits in the dry run](issues/05-plan-and-validate-decisions-and-limits-in-the-dry-run.md) | 02 |
| 06 | [Minimal review loop: reject then approve](issues/06-minimal-review-loop-reject-then-approve.md) | 01, 05 |
| 07 | [Every way a loop can end](issues/07-every-way-a-loop-can-end.md) | 06 |
| 08 | [Parked-agent safety](issues/08-parked-agent-safety.md) | 06 |
| 09 | [Ownership, evidence, cancel and timeouts in loops](issues/09-ownership-evidence-cancel-and-timeouts-in-loops.md) | 06 |
| 10 | [Automatic cleanup on success](issues/10-automatic-cleanup-on-success.md) | 04, 07 |
| 11 | [Loops in the widget and the report](issues/11-loops-in-the-widget-and-the-report.md) | 04, 07 |
| 12 | [Graph topology with fan-out](issues/12-graph-topology-with-fan-out.md) | 01, 02 |
| 13 | [Joins](issues/13-joins.md) | 12 |
| 14 | [Loops inside graphs](issues/14-loops-inside-graphs.md) | 07, 09, 10, 13 |
| 15 | [Fan-out and joins in the widget and dry run](issues/15-fan-out-and-joins-in-the-widget-and-dry-run.md) | 04, 13 |
| 16 | [Graph-aware cancel, recovery and report](issues/16-graph-aware-cancel-recovery-and-report.md) | 14 |
| 17 | [Release: README, release notes and full suites](issues/17-release-readme-release-notes-and-full-suites.md) | 08, 11, 15, 16 |
