# 05: Show the persona

**What to build:** A user can tell persona subagents apart. The widget row and the `/sub` and `/subcont` info lines show the persona name together with the model and thinking level, for example `#3 reviewer · openai/gpt-5 (high)`. A subagent with no persona is shown exactly as today. The result text and notice delivered to the parent are unchanged.

Spec: `../spec.md` (user stories 26, 27; Implementation Decisions: Display).

**Blocked by:** 01 (persona launch).

**Status:** done — merged to feature/subagent-widget-persona

**Delegation tier:** easy (display text through the existing widget assertions) → codex `gpt-6-luna` at `model_reasoning_effort=xhigh`; Opus review at medium effort.

- [x] The widget row for a persona subagent includes the persona name; a persona-less subagent's row is identical to today's.
- [x] The `/sub` and `/subcont` info line shows the persona name with the model and thinking level; persona-less lines are unchanged.
- [x] Rows stay truncated by terminal width with a long persona name, wide characters included.
- [x] The result text and notify-only notice for a persona subagent contain no persona name and are identical to a persona-less result.
- [x] No test depends on a real model. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

## Verification note

Merged as `2b93d6e` plus fix commit `0f71feb` via `ticket/persona-05` (merged with the integration tip including ticket 04 as `e94a43c`), review rounds 1 and 2 (Opus, medium). Round 1 was blocked on three findings (queued row showed an empty model and the wrong thinking level, an unsanitised model in the info line, a newline or tab in a persona name splitting the row); all fixed and verified in round 2. Widget suite `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget/subagent-widget.test.ts`: 96 passed on the merged code (orchestrator and reviewer). `timeout 900 node bootstrap/run-tests.ts deterministic`: 1600 passed (builder, on the pre-merge branch); the first run had concurrency-sensitive failures that passed on rerun.

Open non-blocking items (reviews: scratchpad `review-05-r1.md`, `review-05-r2.md`), scheduled as follow-up `ticket/persona-05b`:
- An alias-resolved persona model is not checked for control characters, and a name that sanitises to nothing falls back to the persona-less info line with the raw model.
- A long model id crowds out the status word and task at widths 41-99.
- The unknown-persona and control-character errors echo raw names and file paths.
- README fallback sentence, and a redundant width branch.

## Follow-up (merged as `ticket/persona-05b`, commit `3725963`)

Closed the open items above: the control-character check now covers the alias-resolved model, a persona name that is empty after sanitising is rejected, the persona info line never falls back to the persona-less template, persona names and file paths in errors are sanitised, the model is dropped below width 80 and capped at 16 columns at 80-99 so status, elapsed time and task survive, and the README fallback sentence is exact. Review (Opus, medium): no blocking findings. Widget suite 98 passed (builder and reviewer); Bootstrap deterministic 1600 passed (builder).

Non-blocking items left open (review: scratchpad `review-05b-r1.md`):
- A few sanitising wrappers have no test (alias key and persona `skills:` entry in error text, missing-snapshotted-skill message).
- Invisible but non-empty names (zero-width space, U+2028) are still accepted; require at least one visible character or strip format characters.
- Truncating the name or model inserts `\x1b[0m`, which cancels the dim styling for the rest of the metadata; strip it as the task label does.
- At width 100 and above the model has no budget, so a long id squeezes the task (status and elapsed time still survive).
- The width-80 threshold is not locked by a test; the 16-column cap hides the distinctive part of long model ids.
- Sanitised error text strips hostile bytes (so `evil` shows for a file `ev<ESC>…il.md` but does not match); an escaped form would be clearer. The alias-model error does not name the alias.
