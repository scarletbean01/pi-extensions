# 04: Output appears when an attempt finishes and survives live polls

**What to build:** While a run is live, a finished attempt's output appears in the selected node's section without reloading the page: the client re-fetches the output when the live snapshot shows that node's attempt reaching a finished status or a new attempt appearing. Output is never polled and never re-downloaded every two seconds. Pan, zoom, selection, open sections and keyboard focus all survive a live poll while output is shown.

Spec: `../spec.md` (user stories 24–28, 31; Implementation Decisions: Client fetching, The pure client-logic script gains the small helper that decides when to re-fetch output; Testing Decisions: Seam 2, Scenario 5 behaviour).

**Blocked by:** 03.

**Status:** done — merged to feature/viewer-agent-output

**Delegation tier:** complex (in-place patching: element identity that pan/zoom, selection, open disclosures and focus depend on must not change) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [x] A small pure helper in the client-logic script decides when output must be fetched again (the selected node's attempt reached a finished status, or a new attempt appeared) and is unit-tested directly.
- [x] In the DOM harness, a node finishing during a poll shows its output without a page reload, and a plain poll with no change issues no output request.
- [x] Switching node or factory aborts an in-flight output request and discards a stale or mismatched response, including a response that arrives after a poll-triggered refetch started.
- [x] Across a live poll with output shown, the existing in-place patching test (Scenario 5) still passes and additionally asserts that open attempt disclosures, the focused element, pan, zoom and selection are unchanged.
- [x] A failed refetch shows an error inside the section only; the graph and the rest of the panel are untouched.
- [x] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

## Verification note

Merged via `ticket/vao-04` (builder commit `f34fd83`), one Opus review round (medium): PASS, no blocking findings. The reviewer mutation-tested the new tests in a scratch copy: a helper that always returns false fails two tests (the helper table and Scenario 5's refetch count); a refetch trigger that is always true fails Scenario 5 (fetch count). A real review-loop sequence (running, parked waiting, attempt 2 running, attempt 2 succeeded, three polls per state) issued exactly one refetch per transition (counts 1,1,1,2,2,2,3,3,3,4,4,4).

Tests: viewer suite `env -u HC_TERMINAL_ID -u HC_TERMINAL_SOCKET -u HC_SCOPE timeout 600 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 bootstrap/factory-web-viewer*.test.ts`: 100 passed (the count did not change because the new cases are blocks inside two existing top-level tests: "served safe.js pure client logic" and "served app.js wiring" with block M and the extended Scenario 5); docs test 7 passed; `node bootstrap/run-tests.ts deterministic`: 1620 of 1623 (builder), the 3 failures are `hc-live-isolation.test.ts`, which cannot run inside an hc cgroup.

Done here: pure helper `shouldRefetchNodeOutput` in `safe.js`; refetch on a finished status or a new attempt, never on a plain poll; stale and mismatched responses discarded (including a pre-poll response arriving after a poll-triggered refetch); in-section error on a failed refetch; open state of the attempt, Structured outputs and Artifacts disclosures kept by stable key and keyboard focus restored across a refetch.

Non-blocking notes carried forward (suggested for a small follow-up before or during ticket 05's browser pass; none blocks ticket 05):
- NB1 (accessibility): a refetch replaces the attempt body inside the detail panel's `aria-live="polite"` region, so a screen reader reads the whole new output (up to 64 KB) once per transition. Set `aria-live="off"` on the Attempt output card (or its slot) and announce a short line through the existing announcer ("Attempt N of node X finished: Succeeded"). `app.js` ~2241, 2292, 2345.
- NB2 (test gap): the focus-restoration path is untested because the harness leaves `fakeDocument.activeElement` on a detached node (`FakeNode.remove`, `replaceChildren`, `insertBefore`); the "focus survives refetch" assertions pass only because the summary elements are reused. Make the harness move `activeElement` to body when a subtree containing it is detached, and add a case that focuses a sub-disclosure summary and then refetches with changed content for that attempt.
- NB3: focus restoration calls `focus()` without `{ preventScroll: true }` (`app.js` ~1245), so the page may scroll when focus is restored.
- NB4: the previous snapshot is taken at fetch time, not at the previous poll (`app.js` ~1257, `safe.js` ~887), so a transient `needs_attention` without `completed_at` followed by the same real status can miss a refetch and leave stale content; keep a separate "last seen live node" updated on every poll and pass it as `prev`. No request storm in the reverse direction.
- NB5: every default open state is recorded as if the user had chosen it (`app.js` ~1219), so a long review loop watched live ends with every attempt expanded (record only explicit toggles); a failed fetch on a node that never transitions again recovers only by selecting another node and returning, because `outputLoadedKey` is already set (let re-selecting the same node retry after an error).

Review file: scratchpad `review-04-r1.md`.

## Follow-up 04b (client follow-ups NB1 to NB5), merged

Done as a separate work item (branch `ticket/vao-04b`, builder agy hydrogen high, commits `4e1d87f`, `0531982`), one Opus review round (medium): PASS, no blocking findings. The reviewer mutation-checked scratchpad copies: deleting the focus-restoration call now fails a test (the harness moves `activeElement` to the body when a subtree holding it is detached, and a test focuses a sub-disclosure summary and refetches changed content for that attempt); the NB4 flap scenario, the helper and the last-seen update are also covered. Viewer suite 100 passed, docs test 7 passed, deterministic 1620 of 1623 (builder; the 3 failures are `hc-live-isolation.test.ts` in an hc cgroup).

Done: NB1 the Attempt output card has `aria-live="off"` and a short announcer line ("Attempt N of node X finished: <Status>") is produced once per transition; NB2 harness focus detach and the missing test; NB3 `focus({ preventScroll: true })`; NB4 "last seen" node updated on every poll and passed as `prev`; NB5 only explicit user toggles are remembered (the newest attempt opens by default, a new newest attempt opens, untouched older attempts return to collapsed) and re-selecting the same node after a failed output fetch retries (click or Enter/Space).

Docs sentences needed in `docs/factory-web-viewer.md` (ticket 05's builder writes them): (1) the Attempt output card is `aria-live="off"` and live polls announce a finished transition through the polite screen-reader announcer ("Attempt N of node X finished: <Status>"); (2) only explicit user disclosure toggles are remembered across refetches, and when a new attempt arrives untouched older attempts return to collapsed; (3) re-selecting the same node after a failed output fetch (click or Enter/Space) retries the output request.

Non-blocking notes from that review, left open (for ticket 05's browser pass or a later small fix):
- The output announcement can overwrite the factory-state announcement in the same poll (the last node finishes and the run state changes in one poll: `mountOrPatchLiveView` sets "Factory live state changed to ..." and the refetch then replaces it in the same polite announcer, `app.js` ~1302-1304 and ~2338-2342). Use a dedicated sr-only polite element for output announcements, or append.
- Test gap: block M7 never advances a poll between a 503 and the re-click, so a regression passing `retryOutputOnError: true` from the poll path (`app.js` ~2012) would survive and retry once per poll forever on a persistent error; advance 2 or 3 polls and assert one call.
- A second genuine entry with identical announcement text is not re-announced (`setTextIfChanged`, `safe.js` ~891-919); clear the announcer before writing (best together with the dedicated output announcer).
- The announcer label trusts `status_text` from the response (`safe.js` ~910-915). Not exploitable today (the server sets it from a fixed table and the node id is validated), but prefer `STATUS_META[status].label` for known statuses.
- Nits: a near-trivial assertion at `bootstrap/factory-web-viewer-assets.test.ts` ~4047; consider renaming `ds.outputNodeSnapshot` to `outputLastSeenNode`.

Review file: scratchpad `review-04b-r1.md`.
