# 06: Management tools only while subagents exist

**What to build:** The list, continue and remove tools are inactive until a subagent exists, and are switched off again when the last is removed, by adding and removing only these names from the active tool set. Descriptions are shortened and no longer duplicated. The saving is measured; if it is under about 150 tokens per parent turn, the change is reverted and this ticket is closed with the measurement recorded.

Spec: `../spec.md` (user stories 20, 21; Implementation Decisions: Lazy management tools).

**Blocked by:** 03 (merged). Relaxed 2026-11-27 to run in parallel with the ticket 05 rebase: the existing `session_start` reset covers reload and new sessions; the `session_shutdown` handler comes with ticket 04, which must reset the tool set there too. Expect small merge conflicts with 05 around the remove and clear paths.

**Status:** done

**Delegation tier:** easy (small, well specified, measured) → codex `gpt-6-luna` at `model_reasoning_effort=high`; Opus review at medium effort.

- [x] At session start only the create tool is active; after the first launch the other three are active; after the last subagent is removed or cleared they are inactive again.
- [x] Tools belonging to other extensions that are active before a switch are still active after it, and tools another extension deactivated stay deactivated.
- [x] A reload or new session starts from the inactive state regardless of the earlier state.
- [x] The per-turn input-token difference with zero subagents is measured before and after and recorded in `docs/token-benchmark/README.md` with the method. The estimated saving is 620 tokens, above the ~150-token threshold, so lazy activation is kept.
- [x] `bootstrap/README.md` and `bootstrap/HOST.md` were checked; no subagent tool claims were found to update.

**Verification:** `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget.test.ts` passed three consecutive runs (32/32 tests each). `pgrep -af '[f]ake-pi'` and `ls /tmp | grep subagent-widget` were empty after each run. The schema estimate is 803 tokens before (3,210 serialized characters) and 183 after (731 characters), saving 620 estimated input tokens per parent turn; method and limitations are in `docs/token-benchmark/README.md`.
