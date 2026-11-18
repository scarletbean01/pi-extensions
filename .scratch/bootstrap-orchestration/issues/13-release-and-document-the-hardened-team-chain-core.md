# 13: Release and document the hardened team/chain core

**What to build:** Ship a coherent, backwards-compatible core before optional orchestration features.

**Track:** Core gate

**Blocked by:** [01: Validate the current reliability changes](01-validate-the-current-reliability-changes.md); [02: Make the host verification harness isolated and reproducible](02-make-the-host-verification-harness-isolated-and-reproducible.md); [03: Allow multiple tasks to use the same persona](03-allow-multiple-tasks-to-use-the-same-persona.md); [04: Expose execution outcomes and dependency policies](04-expose-execution-outcomes-and-dependency-policies.md); [05: Provide bounded shared briefs and explicit input contracts](05-provide-bounded-shared-briefs-and-explicit-input-contracts.md); [06: Distinguish handoff delivery from task acceptance](06-distinguish-handoff-delivery-from-task-acceptance.md); [07: Recover interrupted handoff delivery without rerunning work](07-recover-interrupted-handoff-delivery-without-rerunning-work.md); [08: Cancel runs and enforce configurable deadlines](08-cancel-runs-and-enforce-configurable-deadlines.md); [09: Make independent team execution and ownership explicit](09-make-independent-team-execution-and-ownership-explicit.md)

**Status:** done — merged to main (via integration/bootstrap-orchestration)

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Run legacy and new-format end-to-end fixtures, including repeat-persona teams and three-stage chains.
- [ ] Prove disjoint-writer concurrency, overlapping-writer serialization and verification freshness in the existing project directory without automatic worktrees.
- [ ] Release through the existing generate/status/report/cleanup surfaces plus required recovery/cancellation operations; richer preview, synthesis and expanded /boot commands are not blockers.
- [ ] Exercise crash/restart, duplicate handoff, cancellation, corrupted input and mixed-outcome report scenarios.
- [ ] Document independent team and chain examples, partial policies, output contracts and recovery playbooks.
- [ ] Record supported runtime capabilities and exact skips; use an opt-in isolated live-Herdr fixture for actual tab lifecycle verification.
- [ ] Document downgrade behavior and retain v1 read/report/cleanup support; no automatic side-effect replay.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Core acceptance matrix in the spec passes in the supported environment.
- Live smoke evidence or an explicit unverified limitation accompanies the release.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

This is the accepted first shipping milestone: tasks 01–09 plus this gate. Tasks 10–12 and advanced features are follow-on work. No prototypes are required or authorized; normal implementation and release tests remain mandatory.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
