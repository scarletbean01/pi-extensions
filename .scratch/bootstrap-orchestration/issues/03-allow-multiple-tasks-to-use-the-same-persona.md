# 03: Allow multiple tasks to use the same persona

**What to build:** Launch distinct assignments using one persona, with stable task identities in tools, results and cleanup.

**Track:** Core

**Blocked by:** [01: Validate the current reliability changes](01-validate-the-current-reliability-changes.md)

**Status:** done — merged to integration/bootstrap-orchestration

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Separate run_id (existing public task_id), node_id, persona_name, attempt_id and worker instance/session identity.
- [ ] Accept explicit node IDs and persona references; reject duplicate node IDs while allowing duplicate persona names.
- [ ] Normalize legacy name/sub_task requests into the new representation; preserve legacy chain order.
- [ ] Version newly written plans/configs/results and validate them at read boundaries; keep safe v1 read/report/cleanup support.
- [ ] Show node and persona names in model-facing text; select cleanup by node ID and reject ambiguous persona selectors.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Launch two reviewers with different assignments and collect two distinct results.
- Legacy request equivalence; duplicate IDs; malformed persisted identity; ambiguous cleanup selection.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Do not overload task_id further. New scheduling features require the new format; do not rewrite a live v1 run in place.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
