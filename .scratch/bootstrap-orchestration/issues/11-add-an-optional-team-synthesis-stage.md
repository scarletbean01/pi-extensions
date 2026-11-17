# 11: Add an optional team synthesis stage

**What to build:** Collect independent outputs into one useful final answer with an explicit synthesis assignment.

**Track:** Follow-on usability

**Blocked by:** [04: Expose execution outcomes and dependency policies](04-expose-execution-outcomes-and-dependency-policies.md); [05: Provide bounded shared briefs and explicit input contracts](05-provide-bounded-shared-briefs-and-explicit-input-contracts.md); [07: Recover interrupted handoff delivery without rerunning work](07-recover-interrupted-handoff-delivery-without-rerunning-work.md); [09: Make independent team execution and ownership explicit](09-make-independent-team-execution-and-ownership-explicit.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Allow an optional synthesizer persona/task following team completion using the same worker and handoff contract.
- [ ] Define require-all-success versus summarize-available policies, including partial and failed members.
- [ ] Pass immutable member outputs and unresolved disagreements; retain original results independently.
- [ ] Distinguish synthesis from code integration and verification in plan and report text.
- [ ] Make synthesis failure reportable without losing successful member results; retry only through explicit new-attempt semantics when available.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Two reviewers disagree; one member fails; all succeed; synthesizer fails.
- Duplicate completion events do not launch the synthesizer twice.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

This is a constrained fan-in use case; avoid building a general graph engine solely for this ticket.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
