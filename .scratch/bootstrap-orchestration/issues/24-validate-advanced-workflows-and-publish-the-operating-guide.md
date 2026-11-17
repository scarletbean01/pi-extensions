# 24: Validate advanced workflows and publish the operating guide

**What to build:** Demonstrate that optional collaboration, workspace isolation and graph scheduling compose safely.

**Track:** Advanced gate

**Blocked by:** [02: Make the host verification harness isolated and reproducible](02-make-the-host-verification-harness-isolated-and-reproducible.md); [13: Release and document the hardened team/chain core](13-release-and-document-the-hardened-team-chain-core.md); [17: Keep completed collaborators available under a bounded lease](17-keep-completed-collaborators-available-under-a-bounded-lease.md); [19: Limit active task concurrency with durable admission slots](19-limit-active-task-concurrency-with-durable-admission-slots.md); [21: Launch graph workers only when dependencies are ready](21-launch-graph-workers-only-when-dependencies-are-ready.md); [22: Support bounded review-and-revision attempts](22-support-bounded-review-and-revision-attempts.md); [23: Retain and archive run evidence safely](23-retain-and-archive-run-evidence-safely.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Exercise research team, shared-cwd implementation team, collaborative team, chain, diamond graph and bounded revision workflows without worktree creation by default.
- [ ] Validate the explicitly requested worktree/integration scenario only when shipping that optional track; ticket 15 is a conditional prerequisite for that scenario, not for the non-worktree release.
- [ ] Run restart/cancellation tests across supervisor, worker and handoff boundaries; cover integration when that optional track is included.
- [ ] Measure launch latency, process/tab count, context growth and configured concurrency enforcement using reproducible fixtures.
- [ ] Document opt-in capabilities, trust limits, recovery commands, compatibility and all unsupported cases.
- [ ] Keep advanced capabilities disabled by default until their acceptance evidence is recorded; allow each optional track to ship independently with its own gate subset.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Advanced acceptance matrix and representative demos run on the supported host.
- No user files overwritten, real-provider request or unauthorized publication during automated tests.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

This gate does not delay shipping the core milestone; it covers the combined optional roadmap.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
