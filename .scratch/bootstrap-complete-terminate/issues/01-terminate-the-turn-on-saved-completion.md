# 01: End the worker's turn when `bootstrap_complete` saves its result

**What to build:** When `bootstrap_complete` has durably saved the attempt's result and every required handoff is queued or not required, the worker's model turn ends without the follow-up acknowledgment request. Failures and refusals keep the turn open so the worker can retry. A loop-body worker still parks and still wakes for a revision, and every later attempt of that loop ends its turn the same way. The task prompt tells the worker to call `bootstrap_complete` on its own.

Spec: `../spec.md` (user stories 1–17, 21; Implementation and Testing Decisions).

**Blocked by:** None (can start immediately)

**Status:** done

**Delegation tier:** complex (loop park/wake-up recovery, shared worker completion path) → agy `gemini-4-hydrogen-high`; Opus review at medium effort.

- [x] Each of these returns `terminate: true` with its existing `details.status` and unchanged content: no outbound route; fan-out with all edges queued; chain success; "already persisted and delivered" (including the retry path); a saved `partial` or `failure` status; a `team` worker with no successor; a review-loop decision node's saved result (rejecting verdict with feedback handoff queued, approval, and the exhausted-loop case with no outbound handoff).
- [x] Each of these keeps the turn open (no `terminate`): every `isError` return, the blocked risk-lane return, partial fan-out delivery failure, chain delivery failure, failed feedback-handoff delivery, cancellation and fail-fast refusals, and output or verification validation failures.
- [x] A fan-out worker whose first completion had a failed edge retries, the retry delivers only the undelivered edges, and the retry's result terminates.
- [x] The saved result file, handoff records and delivery state are byte-for-byte what they were before the change in every case, and `bootstrap_recover` behaves as before (existing recovery tests pass unchanged).
- [x] A review-loop worker that completes (turn terminated), parks, receives a revision wake-up, and completes the new attempt works end to end; the second completion also terminates. Existing review-loop tests pass.
- [x] Non-loop workers still shut down after a terminating completion, and loop workers still park, in the same order relative to the return as today.
- [x] A runtime-suite test (real Pi process, local scripted provider, no model spend) runs a two-node review loop: build, review rejects, build wakes for attempt 2 and completes again. It asserts through the provider's unexpected-call check that neither worker made a post-`bootstrap_complete` request on either attempt.
- [x] The composed task prompt includes one sentence telling the worker to call `bootstrap_complete` on its own as a separate step; a test asserts on the prompt text. No code blocks batched calls. The sentence lives in the runtime-composed system prompt; the persisted task input record, its `input_hash`, the plan fingerprint and `request_id` replay are unchanged (a test asserts the hash is unchanged for an identical plan).
- [x] Test runs are wrapped in `timeout` with the repository's test-timeout flag. The deterministic suite shows no regressions (note any pre-existing hang reproduced on main, as in earlier tickets).
- [x] `bootstrap/README.md` and `bootstrap/HOST.md` describe the terminating completion where they describe completion, and are checked for stale claims: at least the agent-protocol `bootstrap_complete` bullet, the reload-recovery retry note, and the `activity_at` liveness paragraph. This ticket's Status is set to done and verified criteria are ticked when it is merged.

Verification note: merged as 91bf201 (feature/terminate-on-complete, commits ccb44d6, 48785d2, 096b00d). Builder ran the runtime suite 50/50 and the deterministic suite 1599/1600 twice; each run failed one different timing-sensitive test under parallel load (`pane-wake.test.ts:1033`, then `factory-viewer-command.test.ts:797`), and both passed standalone. Two Opus (medium) review rounds approved; mutation checks on scratch copies confirmed the new runtime test, the catch-block terminate test, the input_hash test and the exhausted-loop offer check each fail when the behaviour is removed. Focused suites re-run on main: 206/206. The live suite was not run.
