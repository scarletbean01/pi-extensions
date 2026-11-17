# 20: Add an explicit runtime owner for unattended scheduling

**What to build:** Scheduling and recovery can continue when the initiating tool call or dispatcher session ends.

**Track:** Graph

**Blocked by:** [07: Recover interrupted handoff delivery without rerunning work](07-recover-interrupted-handoff-delivery-without-rerunning-work.md); [08: Cancel runs and enforce configurable deadlines](08-cancel-runs-and-enforce-configurable-deadlines.md); [18: Execute explicit dependency graphs using existing workers](18-execute-explicit-dependency-graphs-using-existing-workers.md); [19: Limit active task concurrency with durable admission slots](19-limit-active-task-concurrency-with-durable-admission-slots.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Provide an opt-in run-scoped supervisor process with durable identity, lease and exclusive ownership.
- [ ] Define startup, attach, status, graceful stop and restart through the extension without depending on a foreground wait call.
- [ ] Persist scheduler intent before launches and reconcile ambiguous resource creation with existing ownership rules.
- [ ] On supervisor failure, running workers follow existing contracts; no new launches occur until a verified owner resumes.
- [ ] Keep the default eager team/chain path usable without this supervisor; add lifecycle documentation and resource cleanup.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Dispatcher exits after launch; supervisor restarts; two contenders attempt takeover.
- Crash before/after resource creation and cancellation while dispatcher is absent.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

This introduces a real background lifecycle. It is optional and must not silently become a permanently installed daemon.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
