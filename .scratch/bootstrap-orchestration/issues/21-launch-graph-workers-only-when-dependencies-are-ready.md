# 21: Launch graph workers only when dependencies are ready

**What to build:** Large workflows avoid creating every worker process and tab upfront.

**Track:** Graph

**Blocked by:** [10: Preview the exact executable plan](10-preview-the-exact-executable-plan.md); [20: Add an explicit runtime owner for unattended scheduling](20-add-an-explicit-runtime-owner-for-unattended-scheduling.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Offer explicit eager and lazy launch policies with visible latency/resource tradeoffs.
- [ ] Resolve and snapshot the entire plan before work, then validate each worker's runtime capabilities before its own release.
- [ ] Launch only eligible nodes within process and active-task limits; persist intent and identity around each creation.
- [ ] Define downstream startup failure after upstream work: retain completed outputs and report a blocked/failed stage without claiming global rollback.
- [ ] Recover ambiguous launch attempts without creating duplicate workers.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Long chain initially creates only its first worker; fan-out obeys limits.
- Later model unavailable, supervisor restart during launch, cancellation before next stage, and changed persona file after planning.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Lazy launch relaxes the all-workers-ready guarantee. It must be an explicit plan policy, not an invisible optimization.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
