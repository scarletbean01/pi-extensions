# End the worker's model turn when its result is saved

Status: ready-for-agent. Prepared 2026-11-27 from a grill-with-docs session (6 decisions and the seam check, all accepted as recommended). Vocabulary follows `GLOSSARY.md` (attempt, attempt output, handoff, parked, wake-up, node, run graph). No new domain term was needed and no ADR is warranted: the change is easy to reverse.

## Problem Statement

A graph worker costs more model requests than an equivalent widget worker. A widget worker does `read → answer`. A graph worker does `read → bootstrap_complete → final acknowledgment`. Once `bootstrap_complete` has durably saved the attempt's result and queued its handoffs, the worker has nothing left to say, yet Pi makes one more model request so the model can acknowledge the tool result. Measured in the read-only token benchmark, that request is the main reason graph workers use more tokens than widget workers, even though their first prompts are smaller:

| Graph workload | Measured worker tokens | Without final acknowledgments (estimate) |
|---|---:|---:|
| One no-op | 7,526 | 3,750 |
| Two parallel reads | 23,933 | 15,838 |
| Two reads + join | 34,319 | 21,082 |

The benchmark's own write-up (`docs/token-benchmark/README.md`) is not in the repository. Only the 13 raw session files exist, so the numbers cannot be reproduced from committed material.

## Solution

When `bootstrap_complete` succeeds in saving the attempt's result, its tool result tells Pi to skip the automatic follow-up model request (`terminate: true`). The turn ends; the session does not. A loop-body worker still parks and still wakes for a revision. Anything that leaves the worker with work to do (a validation failure, a failed delivery, cancellation, a blocked risk lane) keeps the turn open exactly as today, so the worker can retry. The task prompt asks the worker to call `bootstrap_complete` on its own, because Pi skips the follow-up request only when every tool result in the batch terminates.

The benchmark is re-created as a committed document and re-run, so the saving is measured, not assumed. Cache-friendly prompt layout and command nodes for deterministic work are recorded there as follow-ups, to be judged on the re-run numbers.

## User Stories

1. As an operator running a graph, I want a worker to stop making model requests once its result is saved, so that I do not pay for an acknowledgment nobody reads.
2. As an operator, I want the saving to apply to workers with no downstream edge, so that terminal nodes (and one-node graphs) are as cheap as possible.
3. As an operator, I want it to apply to fan-out nodes whose handoffs were all queued, so that wide graphs benefit at every node.
4. As an operator, I want it to apply to chain handoffs, so that linear graphs benefit too.
5. As an operator, I want it to apply when a worker records a `failure` status, so that a failed node does not cost an extra request after its failure is already saved.
6. As an operator, I want a retried `bootstrap_complete` that finds the result already persisted and delivered to end the turn as well, so that a redundant retry does not trigger another request.
7. As a worker, I want my turn to stay open when output or verification validation fails, so that I can fix the result and call `bootstrap_complete` again.
8. As a worker, I want my turn to stay open when some fan-out edges failed to deliver, so that I can retry only the undelivered edges.
9. As a worker, I want my turn to stay open when chain delivery failed, so that I can retry delivery without redoing my task.
10. As a worker, I want my turn to stay open when completion is refused because the node was cancelled, the run's fail-fast policy fired, or a cancellation won the race, so that the refusal reaches me and I stop.
11. As a worker, I want my turn to stay open when a risk lane blocks my completion, so that I learn it needs human approval.
12. As a review-loop participant, I want to park and later wake for a revision after my turn was terminated, so that loops keep working.
13. As a review-loop participant, I want a revision attempt to be able to complete and terminate again, so that every attempt of a loop gets the saving, not only the first.
14. As an operator, I want an attempt's saved result, handoff records and delivery state to be exactly what they are today, so that recovery and the handoff offer remain the only authority.
15. As an operator, I want `bootstrap_recover` to behave as before, so that repairing delivery from a saved result is unchanged.
16. As a worker, I want the task prompt to tell me to call `bootstrap_complete` on its own and not alongside other tools, so that the saving is not lost to a mixed batch.
17. As a maintainer, I want a missed saving (the model batched the call anyway) to cost only one extra request and never a wrong result, so that no code has to police batching.
18. As a maintainer, I want `docs/token-benchmark/README.md` to describe the method, workloads and baseline totals, so that anyone can reproduce the comparison.
19. As a maintainer, I want an after-change run of the same benchmark recorded beside the baseline, so that the saving is a measured number.
20. As a maintainer, I want prompt-cache layout and command nodes recorded as follow-ups with their evidence, so that the next optimization is chosen from data.
21. As a maintainer, I want `bootstrap/README.md` and `HOST.md` to describe the terminating completion where they describe completion, so that the documentation does not go stale.

## Implementation Decisions

- **Module changed:** the worker's `bootstrap_complete` tool (the completion path of the bootstrap worker), plus the task prompt it composes for each attempt. No change to Pi, to the handoff offer, to Coms, or to recovery.
- **Terminating results.** The tool result carries `terminate: true` on every return that means "the attempt's result is durably saved and every required handoff is queued or not required":
  - the graph success with no outbound route (handoff `not_required`);
  - the graph fan-out success when all edges are queued;
  - the chain success, including a worker with no successor (a `team` worker takes this path; it must not be gated on graph topology);
  - the "already persisted and delivered" returns (including the retry path);
  - a saved `partial` or `failure` status: all three agent-reported statuses are valid saved results and are treated identically;
  - a review-loop decision node's saved result: the rejecting verdict whose feedback handoff to the loop target was queued, the approval, and the exhausted-loop case where no outbound handoff is sent (`on_exhausted`).
- **Non-terminating results.** Every `isError` return, the blocked risk-lane return, partial fan-out delivery failure, chain delivery failure and failed feedback-handoff delivery keep the turn open, unchanged. The saved result is retained in those cases and the worker may retry, as today.
- **Turn, not session.** Termination is a hint that skips the follow-up model request. Existing shutdown (for non-loop workers) and `park()` (for loop-body workers) stay as they are, in the same order relative to the return. A parked worker must still accept the next assigned attempt.
- **Batching.** `bootstrap_complete` is sequential. Pi honours `terminate` only when every tool result in the batch terminates. The task prompt gets one added sentence telling the worker to call `bootstrap_complete` alone, as its own step. No code blocks batched calls: the cost of a miss is one extra request, not a correctness bug. The sentence belongs in the runtime-composed system prompt, not in the persisted task input record, so the input hash, the plan fingerprint and `request_id` idempotency are unchanged.
- **Loop workers are in scope for this ship.** Their wake-ups arrive as new prompts, not as the tail of the terminated turn. The unproven assumption (a terminated turn leaves a parked Pi session able to take the next prompt) is an explicit acceptance criterion.
- **Benchmark.** `docs/token-benchmark/README.md` is re-created from the 13 session files: workloads (one no-op; two parallel reads; two reads and a join), method, widget-versus-graph comparison, baseline totals (including the model-dispatched cost estimate and uncached-input counts) and the follow-ups. The same workloads are re-run after the change and recorded in the same document. The follow-ups (stable prompt prefix and tool-schema ordering; command nodes for deterministic extraction, validation and merging) are written up there only, with no ticket.

## Testing Decisions

- **Primary seam:** the `bootstrap_complete` tool result as the worker's registered tool returns it, in the fake-Pi style the worker tests already use.
- **One runtime proof of the unproven assumption:** a fake-Pi harness only shows the worker's own hooks accept a second prompt. One test in the runtime suite (real Pi process, local scripted provider, zero model spend) runs a two-node review loop: build, review rejects, the build worker wakes for attempt 2 and completes again. It asserts through the provider's unexpected-call check that neither worker made a post-`bootstrap_complete` request on either attempt. Prior art: the real-Pi parked loop worker test in the runtime smoke suite. Tests assert only external behaviour: the `terminate` flag together with `details.status`, the saved result and delivery state, and the next prompt a parked worker accepts. They never assert internal variables.
- **Cases to cover:** each terminating return above (including `partial`, a `team` worker, a rejecting verdict with feedback queued, and an exhausted loop); each non-terminating return above; a retry after a failed fan-out delivery that then succeeds and terminates; a loop worker that parks, receives a revision wake-up and completes again.
- **Prompt wording:** assert on the composed task prompt (the sentence about calling `bootstrap_complete` alone), as the worker tests already do for other prompt contents.
- **Prior art:** the worker, graph fan-out, review-loop and core-acceptance tests.
- **No real-model test.** The scripted-provider runtime test and the benchmark re-run are the live checks. Always wrap test runs in `timeout` with the repository's test timeout flag; a stuck test has hung builders for tens of minutes before.

## Out of Scope

- Changing prompt or tool-schema layout for cache hits (follow-up, gated on re-run numbers).
- Command nodes in place of model nodes (follow-up).
- Enforcing single-tool batches in code.
- Any change to handoff authority, wake-up transport, recovery or Pi itself.

## Further Notes

- The baseline table above is the estimate from subtracting observed acknowledgment requests, not a patched benchmark. The re-run replaces it with measured numbers.
- In the model-dispatched test, removing the acknowledgments was estimated to save about 4.5% of spend, because they were mostly cached. The goal of this work is the token-volume and latency reduction and a clean measurement; the larger cost lever is uncached input, which is the first follow-up.
- Every ticket that changes behaviour must keep `bootstrap/README.md` and `bootstrap/HOST.md` in step and check them for stale claims. Known spots in the README: the agent-protocol `bootstrap_complete` bullet ending "requests graceful child shutdown after successful persistence/delivery" (add the terminating completions and the refusals that keep the turn open); the reload-recovery note about retrying the handoff with `bootstrap_complete` (a successful retry, or one that finds delivery settled, also terminates the turn); and the deadlines and liveness paragraph on `activity_at`, which stays accurate but must be checked against shutdown and park timing.
- The skipped final turn must not change park or shutdown timing: both stay driven by the completion path, not by the model's last turn.
