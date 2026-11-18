# 06: Minimal review loop: reject then approve

**What to build:** The tracer bullet. A two-node chain, builder then reviewer with a decision, launches and runs a full loop: the reviewer rejects, both nodes re-run as attempt 2 on the same live agents, the reviewer approves and the run completes.

**Blocked by:** [01: Generalise the run fixture to N nodes with simulated tab close](01-generalise-the-run-fixture-to-n-nodes-with-simulated-tab-close.md); [05: Plan and validate decisions and limits in the dry run](05-plan-and-validate-decisions-and-limits-in-the-dry-run.md)

**Status:** ready-for-agent

- [ ] Plans with a decision launch; every node uses attempt-scoped record names from attempt 1; plans without a decision keep legacy names.
- [ ] After delivering an attempt, loop-body agents park instead of shutting down; parked agents have no task tools.
- [ ] The verdict is read from the validated `success` result; reject with budget left re-runs the whole loop body in dependency order as attempt n+1 by the same agents.
- [ ] The builder's revision input carries the findings and references to earlier results; the reviewer's next input references its own earlier verdicts and findings; both are retrievable with `bootstrap_read_input`.
- [ ] Approval writes finalize records for the body; the run outcome becomes terminal (`succeeded`) while agents are still alive.
- [ ] Revision and attempt counters are durable.
- [ ] `bootstrap_status` shows `attempt n/max` and parked or finalized per node.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
