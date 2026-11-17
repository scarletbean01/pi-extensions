# 10: Preview the exact executable plan

**What to build:** Inspect resolved roles, dependencies and policies before launch and detect changes between preview and execution.

**Track:** Follow-on usability

**Blocked by:** [03: Allow multiple tasks to use the same persona](03-allow-multiple-tasks-to-use-the-same-persona.md); [04: Expose execution outcomes and dependency policies](04-expose-execution-outcomes-and-dependency-policies.md); [05: Provide bounded shared briefs and explicit input contracts](05-provide-bounded-shared-briefs-and-explicit-input-contracts.md); [09: Make independent team execution and ownership explicit](09-make-independent-team-execution-and-ownership-explicit.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Extend the existing preview rather than adding another resolver; preview and generate use the same normalized plan.
- [ ] Show persona sources, model resolution, declared tools/extensions, workspace strategy, dependency policies and ownership conflicts.
- [ ] Show shared cwd when strategy is omitted. Worktree strategy requires an explicit user request; ownership conflicts never trigger an automatic strategy change, and preview never creates a worktree.
- [ ] Create a plan digest covering resolved inputs and explicit defaults; changed personas/configuration invalidate an expected digest.
- [ ] Check model availability and runtime capabilities locally where possible; label checks that require worker startup as unverified.
- [ ] Keep preview free of tabs and model calls; canonical retries honor existing reservation versions safely.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Preview/generate equivalence; default versus explicit values; reordered request fields.
- Persona changed after preview; unavailable model; unsupported runtime feature; legacy reservation retry.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Preview is optional for routine use. Do not introduce an unconditional approval prompt.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
