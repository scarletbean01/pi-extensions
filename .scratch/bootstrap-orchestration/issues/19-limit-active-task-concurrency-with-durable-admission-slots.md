# 19: Limit active task concurrency with durable admission slots

**What to build:** Run wide graphs within a configured active-task budget and provider-specific limits.

**Track:** Graph

**Blocked by:** [08: Cancel runs and enforce configurable deadlines](08-cancel-runs-and-enforce-configurable-deadlines.md); [18: Execute explicit dependency graphs using existing workers](18-execute-explicit-dependency-graphs-using-existing-workers.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Persist admission slots tied to node/attempt ownership; release only after terminal evidence or explicit reconciliation.
- [ ] Support max active tasks and optional provider limits with deterministic eligible-node ordering.
- [ ] Queued nodes make no task model requests before receiving a slot.
- [ ] Cancel and restart preserve queue state; expired process identity does not automatically replay a claimed task.
- [ ] Report queued reasons and distinguish active-task limits from total prelaunched processes/tabs.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Wide graph respects capacity; provider limit; simultaneous slot claims.
- Crash while holding a slot, cancelled queued task, stalled task and deterministic scheduling after restart.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Do not promise lower process count until lazy worker launch is implemented.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
