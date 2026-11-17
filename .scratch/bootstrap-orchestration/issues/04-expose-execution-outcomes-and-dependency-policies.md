# 04: Expose execution outcomes and dependency policies

**What to build:** Tell the dispatcher whether work ran, was blocked, or needs intervention, and gate chain stages explicitly.

**Track:** Core

**Blocked by:** [03: Allow multiple tasks to use the same persona](03-allow-multiple-tasks-to-use-the-same-persona.md)

**Status:** done — merged to integration/bootstrap-orchestration

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Represent launch/resource state separately from execution state, worker-reported outcome and verification evidence.
- [ ] A reported success cannot satisfy a dependency requiring checks unless those checks have passing, current evidence; expose missing, unverified and stale evidence distinctly.
- [ ] Use execution states pending, waiting, running, succeeded, partial, failed, blocked, skipped, cancelled and needs_attention, with recorded cause references.
- [ ] Define require_success and allow_partial dependency policies; new-format plans default to require_success, while legacy plans retain allow_partial behavior.
- [ ] Distinguish a worker's own failure from downstream work that never executed; propagate causes across the full chain.
- [ ] Define deterministic run aggregation and report all terminal nodes without inventing successful results for skipped work.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Success/partial/failure policy matrix; multi-step upstream failure; mixed team outcomes.
- Worker reports success but required checks fail, are absent or are stale: dependent work is not admitted.
- All-terminal failed runs produce reports; resource cleanup does not erase execution outcomes.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Transport failure and ambiguous execution are attention conditions, not permission to replay the task.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
