# 15: Integrate isolated outputs with explicit conflict handling

**What to build:** Combine explicitly requested isolated member outputs in a requested integration workspace and verify the combined result. Shared-cwd workflows do not require this feature.

**Track:** Workspace

**Blocked by:** [04: Expose execution outcomes and dependency policies](04-expose-execution-outcomes-and-dependency-policies.md); [05: Provide bounded shared briefs and explicit input contracts](05-provide-bounded-shared-briefs-and-explicit-input-contracts.md); [14: Run implementation members in isolated worktrees](14-run-implementation-members-in-isolated-worktrees.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Require member artifacts to identify their commits/patches and base; reject unrelated or changed references.
- [ ] Apply changes in a deterministic declared order in a dedicated integration workspace only within the user's requested scope; an extra integration worktree requires explicit opt-in, not inferred authorization from synthesis or revision.
- [ ] Stop on conflicts with actionable diagnostics and retain member outputs; never silently choose a side.
- [ ] Run declared verification after integration and report member success separately from integrated-build success.
- [ ] Persist integration progress so interruption cannot duplicate application; leave merge into the user's branch as an explicit action.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Disjoint changes; overlapping conflict; individually passing changes fail combined tests.
- Restart after one applied change; repeated integration request; dirty user branch remains untouched.
- Shared-cwd synthesis, verification and revision do not create an integration worktree.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Integration is separate from synthesis and never implies permission to publish or merge.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
