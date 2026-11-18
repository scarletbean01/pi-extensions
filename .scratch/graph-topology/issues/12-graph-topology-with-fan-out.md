# 12: Graph topology with fan-out

**What to build:** An orchestrator can launch `topology: graph` with `depends_on`, so one node fans out to several successors that run in parallel. No joins yet.

**Blocked by:** [01: Generalise the run fixture to N nodes with simulated tab close](01-generalise-the-run-fixture-to-n-nodes-with-simulated-tab-close.md); [02: Represent every plan internally as nodes with inbound edges](02-represent-every-plan-internally-as-nodes-with-inbound-edges.md)

**Status:** done — merged to main

- [x] `topology: graph`, node form only, `depends_on`; validation of unknown IDs, duplicates, self-dependencies, cycles and more than 32 nodes in the dry run; a new fingerprint version; new manifest and config versions a previous release rejects.
- [ ] A plan with a join is refused until the joins ticket lands. — SUPERSEDED by ticket 13, which lands joins (the temporary refusal was removed by design).
- [x] Fan-out delivery offers one handoff per outbound edge, with handoff records scoped by source; delivery state is tracked per edge.
- [x] A retried `bootstrap_complete` re-sends only undelivered edges from the saved result and never re-runs the task.
- [x] Edge state (`pending`, `fired`, `dead`) is computed by one pure function from existing records, never stored; `bootstrap_status` shows per-edge state.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
