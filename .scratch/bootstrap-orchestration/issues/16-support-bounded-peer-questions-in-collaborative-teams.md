# 16: Support bounded peer questions in collaborative teams

**What to build:** Members can ask for information without giving peers a second assignment or losing message identity.

**Track:** Collaboration

**Blocked by:** [05: Provide bounded shared briefs and explicit input contracts](05-provide-bounded-shared-briefs-and-explicit-input-contracts.md); [06: Distinguish handoff delivery from task acceptance](06-distinguish-handoff-delivery-from-task-acceptance.md); [09: Make independent team execution and ownership explicit](09-make-independent-team-execution-and-ownership-explicit.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Add opt-in collaborative mode with typed question, answer, update and blocker messages.
- [ ] Correlate messages with run, node, attempt and conversation IDs; validate membership and message type.
- [ ] Keep received facts separate from assignment authority; peer messages cannot change ownership, dependencies or completion policy.
- [ ] Use asynchronous replies and bounded queues/timeouts; avoid both peers blocking while awaiting each other.
- [ ] Preserve messaging behavior for non-bootstrap Coms users; rejected requests return an explicit reason.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Two simultaneous questions; duplicate/out-of-order reply; wrong-run message.
- Both peers ask at once; timeout; peer update cannot reopen completed work or overwrite the task.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Use an internal messaging adapter only where bootstrap behavior differs; do not redesign all of Coms.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
