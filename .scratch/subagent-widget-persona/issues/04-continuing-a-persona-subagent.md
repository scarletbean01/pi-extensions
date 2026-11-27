# 04: Continuing a persona subagent

**What to build:** A persona subagent stays that persona across follow-ups. The resolved persona (prompt text, tools, skills, name, model and thinking) is snapshotted on the subagent's state at launch. `/subcont` and `subagent_continue` reuse the snapshot, so editing the persona file afterwards changes nothing for a subagent that has already started. `--persona` and `--write` are rejected on continue. `--model` and `--thinking` overrides still work and stay sticky as today. `--skills` on a continue adds to the persona's skills for that turn only. A continue of a subagent that had no persona behaves exactly as today.

Spec: `../spec.md` (user stories 21–25; Implementation Decisions: Continuation).

**Blocked by:** 01 (persona launch), 02 (prompt delivery), 03 (tools and skills).

**Status:** done — merged to feature/subagent-widget-persona

**Delegation tier:** complex (touches subagent state, queued launches and lifecycle) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [x] A continue after launch passes the same prompt delivery, tools and skills as the first turn, through the fake `pi` executable.
- [x] Changing or deleting the persona file between launch and continue does not change what the continue launches.
- [x] `--persona` and `--write` on `/subcont` fail with a clear error and no child process; `subagent_continue` has no persona parameter and rejects write access for a persona subagent.
- [x] `--model` and `--thinking` overrides on a continue are used and stored for the next continuation; with no override, the stored values are used.
- [x] `--skills` on a continue adds to the persona's list for that turn and is not stored for the next turn.
- [x] A queued continue, a failed continue that is retried, and removal of the subagent (including its persona prompt file from ticket 02) behave as for a persona-less subagent.
- [x] A continue of a persona-less subagent passes the same arguments as before this ticket.
- [x] No test depends on a real model. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

## Verification note

Merged as `5234fb8` plus fix commit `0f9e200` via `ticket/persona-04`, review rounds 1 and 2 (Opus, medium): no blocking code findings; round 1 required a README fix (two dropped rules restored), verified in round 2. Widget suite `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget/subagent-widget.test.ts`: 86 passed (builder and reviewer). `timeout 900 node bootstrap/run-tests.ts deterministic`: 1600 passed (builder).

Decision recorded in the spec (Resolution result): the snapshot holds the persona's skills resolved to paths at launch, and a continue fails cleanly if a snapshotted skill file has vanished. Review notes for ticket 03 are closed by this ticket: skill snapshot decision, `--skills` per turn only, `--write`/`--persona` rejection on continue, `HOST.md` reduced to a pointer.

Non-blocking items left open (reviews: scratchpad `review-04-r1.md`, `review-04-r2.md`):
- `checkExists` exempts skills that were already missing at launch, which exists to suit test fixtures with non-existent skill paths; README says each snapshotted path is checked. Either create real `SKILL.md` fixtures and check every path, or comment why the flag exists.
- No test for a skill vanishing while a continuation is queued (the spawn-time check is only exercised indirectly); the vanish test asserts either path where it should assert the deleted one.
- The widget header usage comment still does not describe continuation; ticket 06 takes it.
