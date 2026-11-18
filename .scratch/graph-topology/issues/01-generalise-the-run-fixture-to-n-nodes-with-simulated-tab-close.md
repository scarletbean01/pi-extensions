# 01: Generalise the run fixture to N nodes with simulated tab close

**What to build:** Tests can launch a run of any number of nodes through the real bootstrap service with a fake Herdr executor, drive each node's agent (complete, deliver a notification) and simulate closing an agent's tab through its shutdown hook, then observe only through status and report. Test-support refactor; no production behaviour changes.

**Blocked by:** None (can start immediately)

**Status:** done — merged to main

- [x] The fixture accepts any node-form plan and exposes a driver per node, keyed by node ID.
- [x] A driver can simulate the agent's tab closing (shutdown hook) and the process vanishing without a hook.
- [x] Every existing test that used the two-node chain fixture is migrated or still passes unchanged.
- [x] No production module changes.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
