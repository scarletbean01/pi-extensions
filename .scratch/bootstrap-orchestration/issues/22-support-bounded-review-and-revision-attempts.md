# 22: Support bounded review-and-revision attempts

**What to build:** Review findings can request a controlled new implementation attempt followed by verification.

**Track:** Graph

**Blocked by:** [05: Provide bounded shared briefs and explicit input contracts](05-provide-bounded-shared-briefs-and-explicit-input-contracts.md); [07: Recover interrupted handoff delivery without rerunning work](07-recover-interrupted-handoff-delivery-without-rerunning-work.md); [18: Execute explicit dependency graphs using existing workers](18-execute-explicit-dependency-graphs-using-existing-workers.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Represent revision as a new immutable attempt with links to prior inputs, result and review findings.
- [ ] Keep each execution graph acyclic by expanding attempts; do not introduce unrestricted cycles.
- [ ] Require declared revision limit, accepted output contract and termination rule.
- [ ] Never overwrite previous results or automatically replay an ambiguous attempt; operator action resolves uncertainty.
- [ ] Run revisions in the existing project cwd by default; preserve an explicitly requested workspace strategy without creating additional worktrees outside its scope.
- [ ] Update reports to identify the accepted attempt and retain failed/rejected evidence; integrate isolated outputs only when that optional feature is requested and available.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Shared-cwd implement-review-revise-review succeeds with zero worktree creation; revision budget exhausts; invalid review contract.
- Crash during revision, duplicate request and explicit abandonment of an uncertain attempt.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Worktree support and isolated integration are not prerequisites. When explicitly requested, isolated revision integration additionally uses ticket 15. Shared-cwd revisions retain immutable result evidence but do not promise a filesystem snapshot or rollback of each attempt. Broader autonomous replanning remains out of scope.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
