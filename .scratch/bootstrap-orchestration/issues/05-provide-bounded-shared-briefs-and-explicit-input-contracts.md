# 05: Provide bounded shared briefs and explicit input contracts

**What to build:** Give workers the goal, roster, ownership and relevant upstream evidence without losing earlier decisions.

**Track:** Core

**Blocked by:** [03: Allow multiple tasks to use the same persona](03-allow-multiple-tasks-to-use-the-same-persona.md)

**Status:** done — merged to integration/bootstrap-orchestration

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Build on the existing task/roster additions: inject goal, acceptance criteria, constraints, role and bounded roster consistently.
- [ ] Store immutable task inputs and an upstream-results index; distinguish authoritative assignment instructions from peer-produced data.
- [ ] Add declared output fields or a bounded schema contract for stages that require machine-checkable results.
- [ ] Validate required upstream output before admission; malformed or missing artifacts produce a concrete blocker.
- [ ] Use structured summaries plus artifact references with producer/attempt/hash metadata; mark truncation and explain how to retrieve full input.
- [ ] Verification evidence records check identity, result and relevant repository content before and after execution, including relevant untracked inputs; do not rely on commit ID alone.
- [ ] Preserve historical check results but mark applicability stale after relevant changes, or unknown when it cannot be established. Required current evidence must be refreshed before dependent admission; no worktree is created.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Repeated personas receive different assignments; long roster and multibyte results stay bounded.
- Missing/deleted artifact, changed content hash, invalid required output, and access to an earlier stage's decision.
- Relevant edits during or after a passing check invalidate applicability; unrelated edits outside a declared reliable scope do not. Unknown scope is handled conservatively, including non-Git projects.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Hashing detects changed evidence; it does not turn same-user workers into mutually isolated security principals.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
