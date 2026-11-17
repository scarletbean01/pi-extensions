# 09: Make independent team execution and ownership explicit

**What to build:** Parallel workers receive clear boundaries and cannot accidentally delegate new tasks through peer prompts.

**Track:** Core

**Blocked by:** [04: Expose execution outcomes and dependency policies](04-expose-execution-outcomes-and-dependency-policies.md); [05: Provide bounded shared briefs and explicit input contracts](05-provide-bounded-shared-briefs-and-explicit-input-contracts.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Default new plans to independent assignments and require explicit opt-in for collaboration; legacy requests retain their existing messaging behavior with visible guidance.
- [ ] Declare read/write ownership, allow parallel work with disjoint write scopes and serialize known overlapping writers in deterministic plan order. Report the resulting waits in preview/status.
- [ ] Persist ownership admission across reload/recovery; do not release a conflicting writer solely because its heartbeat disappears when execution remains uncertain. This narrow ownership scheduler does not depend on the later graph engine.
- [ ] Reject unsolicited peer task activation in independent mode while preserving internal coordination and user controls.
- [ ] Keep successful members independent of another member's failure; allow an explicit fail-fast policy.
- [ ] Document that shared-cwd ownership is an advisory contract unless backed by existing enforcement or separate workspaces.
- [ ] Use the existing project cwd by default. Known ownership conflicts queue writers; diagnostics cannot authorize or automatically create worktrees.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Disjoint writers execute concurrently; overlapping paths serialize; parent-directory and whole-project scopes conflict correctly; peer prompts cannot activate extra work.
- Cancellation, restart and uncertain execution preserve ownership ordering without admitting a conflicting writer prematurely.
- One member fails while others finish; fail-fast cancellation; legacy policy compatibility.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Do not describe path declarations or active tool lists as a filesystem sandbox.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
