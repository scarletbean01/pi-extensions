# 18: Execute explicit dependency graphs using existing workers

**What to build:** Run workflows with parallel branches and joins while retaining team and chain presets.

**Track:** Graph

**Blocked by:** [03: Allow multiple tasks to use the same persona](03-allow-multiple-tasks-to-use-the-same-persona.md); [04: Expose execution outcomes and dependency policies](04-expose-execution-outcomes-and-dependency-policies.md); [05: Provide bounded shared briefs and explicit input contracts](05-provide-bounded-shared-briefs-and-explicit-input-contracts.md); [06: Distinguish handoff delivery from task acceptance](06-distinguish-handoff-delivery-from-task-acceptance.md); [07: Recover interrupted handoff delivery without rerunning work](07-recover-interrupted-handoff-delivery-without-rerunning-work.md); [11: Add an optional team synthesis stage](11-add-an-optional-team-synthesis-stage.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Add an opt-in graph plan with explicit depends_on edges; reject unknown references, self-dependencies and cycles.
- [ ] Normalize team to independent nodes and chain to ordered edges; preserve their public request forms.
- [ ] Initially prelaunch all graph workers using the existing readiness barrier; an eligible worker claims only after every required input is terminal and acceptable.
- [ ] Fan-in consumes a stable input set with per-edge success/partial policy; downstream blocked causes identify the failed dependency.
- [ ] Reuse the synthesis path rather than creating a competing join protocol; status shows graph readiness.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Diamond graph; multiple roots; mixed policies at a join; cycle and unknown node.
- Duplicate notifications and simultaneous upstream completion launch each node at most once per attempt.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

First graph support can keep all workers prelaunched. Resource scheduling is a separate ticket.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
