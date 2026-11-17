# 07: Recover interrupted handoff delivery without rerunning work

**What to build:** The dispatcher can repair delivery from saved evidence, including when the predecessor has exited.

**Track:** Core

**Blocked by:** [06: Distinguish handoff delivery from task acceptance](06-distinguish-handoff-delivery-from-task-acceptance.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Expose an explicit recovery operation with inspect and retry_delivery actions and model-facing next steps.
- [ ] Reconcile source result, handoff, acceptance receipt, destination identity and final result before taking action.
- [ ] The dispatcher may retry the same logical handoff without fresh user confirmation when evidence demonstrates it remains unclaimed and the destination is valid; never replace the original result.
- [ ] Require an explicit decision before starting a new attempt with uncertain prior side effects. Missing acceptance evidence alone must not override evidence of execution.
- [ ] Serialize recovery with launch/cleanup and reject recovery after cancellation or incompatible plan changes.
- [ ] Return needs_attention for uncertain execution, missing evidence or claimed-but-unfinished work; preserve all diagnostic records.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Predecessor exits after saving result; ACK lost after acceptance; destination completes before recovery.
- Concurrent recovery callers; recovery versus cleanup; corrupt receipt and unavailable project directory.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Delivery retry is distinct from a new task attempt. Recovery must work without asking a model to reconstruct the result.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
