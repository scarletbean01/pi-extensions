# 08: Cancel runs and enforce configurable deadlines

**What to build:** Stop released work gracefully and explain which dependent tasks will not run.

**Track:** Core

**Blocked by:** [04: Expose execution outcomes and dependency policies](04-expose-execution-outcomes-and-dependency-policies.md); [06: Distinguish handoff delivery from task acceptance](06-distinguish-handoff-delivery-from-task-acceptance.md)

**Status:** done — merged to integration/bootstrap-orchestration

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Provide cancellation for a whole run or selected nodes, separate from closing tabs and deleting files.
- [ ] Persist cancellation before signalling workers; workers observe it after release and deny new task admission.
- [ ] Define running-task duration, dependency wait and liveness checks separately; do not equate a heartbeat with useful progress.
- [ ] After a grace period, expose an explicit force-close action scoped to verified owned resources.
- [ ] Define completion-versus-cancellation precedence using durable records; preserve completed results and mark downstream blockers.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Cancel before release, while waiting, during tool work and simultaneously with completion.
- Long healthy predecessor, live-but-stalled worker, dispatcher restart, and replacement user session ownership.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

A hook cannot undo a tool side effect already in progress. Cancellation reports must describe that limit.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
