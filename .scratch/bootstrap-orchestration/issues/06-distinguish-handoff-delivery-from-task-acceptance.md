# 06: Distinguish handoff delivery from task acceptance

**What to build:** A predecessor can prove that its successor accepted the exact saved input.

**Track:** Core

**Blocked by:** [04: Expose execution outcomes and dependency policies](04-expose-execution-outcomes-and-dependency-policies.md); [05: Provide bounded shared briefs and explicit input contracts](05-provide-bounded-shared-briefs-and-explicit-input-contracts.md)

**Status:** done — merged to main (via integration/bootstrap-orchestration)

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Use a durable handoff ID bound to run, source attempt, destination node and input digest.
- [ ] Record queued/accepted states independently from destination running/completed states; a Coms transport ACK never implies acceptance.
- [ ] Atomically claim a handoff before model work, persist acceptance, and reject wrong run, sender, destination or input digest.
- [ ] Replay duplicate notifications harmlessly and return the existing acceptance evidence.
- [ ] Treat a claimed task with no result after a crash as needs_attention; do not reset the claim automatically.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Queue ACK followed by worker rejection; two duplicate notifications arriving concurrently.
- Crash before claim, after claim and after result persistence; wrong-attempt and changed-input handoffs.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Keep Coms as a wake-up/notification path; durable records decide whether work may execute.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
