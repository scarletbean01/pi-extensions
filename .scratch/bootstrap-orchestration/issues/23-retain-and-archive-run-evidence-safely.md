# 23: Retain and archive run evidence safely

**What to build:** Keep the recovery index useful as run history grows without deleting active or valuable work.

**Track:** Operations

**Blocked by:** [03: Allow multiple tasks to use the same persona](03-allow-multiple-tasks-to-use-the-same-persona.md); [07: Recover interrupted handoff delivery without rerunning work](07-recover-interrupted-handoff-delivery-without-rerunning-work.md); [08: Cancel runs and enforce configurable deadlines](08-cancel-runs-and-enforce-configurable-deadlines.md); [12: Make inspection, reporting and recovery usable from /boot](12-make-inspection-reporting-and-recovery-usable-from-boot.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Provide archive/list filters and an explicit dry-run prune operation with age/size criteria.
- [ ] Never prune active locks, running/uncertain attempts, referenced artifacts, dirty worktrees or unmerged integration output.
- [ ] Retain request-id tombstones so archived runs cannot accidentally launch duplicate work.
- [ ] Document process-crash versus power-loss guarantees; if stronger durability is selected, flush critical records and directory updates and test error propagation.
- [ ] Reject unsafe or symlinked managed paths and preserve per-run corruption diagnostics.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Archive completed run; retry old request ID; prune cancelled run with retained evidence.
- Active/ambiguous run excluded; dangling symlink; storage-full failure; shared artifact still referenced.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Power-loss guarantees are an explicit deployment choice; ordinary atomic rename alone must not be described as full power-loss durability.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
