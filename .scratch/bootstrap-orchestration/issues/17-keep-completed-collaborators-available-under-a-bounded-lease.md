# 17: Keep completed collaborators available under a bounded lease

**What to build:** A member can finish its task and answer later questions until the team releases it.

**Track:** Collaboration

**Blocked by:** [08: Cancel runs and enforce configurable deadlines](08-cancel-runs-and-enforce-configurable-deadlines.md); [16: Support bounded peer questions in collaborative teams](16-support-bounded-peer-questions-in-collaborative-teams.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Separate task completion from worker availability and expose both in status.
- [ ] Allow ready-to-answer mode only for collaborative plans, with an idle lease and explicit coordinator release.
- [ ] Consultation cannot mutate the original result or start further implementation; follow-up implementation requires a new attempt.
- [ ] Expiry, cancellation or coordinator loss produces deterministic shutdown behavior.
- [ ] Bound consultation turns and usage where runtime counters exist; clearly report unavailable usage metrics.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Early finisher answers a late question; independent member still shuts down immediately.
- Lease expires, coordinator disappears, cancellation arrives during consultation, duplicate release.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Keeping a worker alive has resource and potential model-use costs; enable this only when requested by the plan.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
