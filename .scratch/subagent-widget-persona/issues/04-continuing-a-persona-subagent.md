# 04: Continuing a persona subagent

**What to build:** A persona subagent stays that persona across follow-ups. The resolved persona (prompt text, tools, skills, name, model and thinking) is snapshotted on the subagent's state at launch. `/subcont` and `subagent_continue` reuse the snapshot, so editing the persona file afterwards changes nothing for a subagent that has already started. `--persona` and `--write` are rejected on continue. `--model` and `--thinking` overrides still work and stay sticky as today. `--skills` on a continue adds to the persona's skills for that turn only. A continue of a subagent that had no persona behaves exactly as today.

Spec: `../spec.md` (user stories 21–25; Implementation Decisions: Continuation).

**Blocked by:** 01 (persona launch), 02 (prompt delivery), 03 (tools and skills).

**Status:** ready-for-agent

**Delegation tier:** complex (touches subagent state, queued launches and lifecycle) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [ ] A continue after launch passes the same prompt delivery, tools and skills as the first turn, through the fake `pi` executable.
- [ ] Changing or deleting the persona file between launch and continue does not change what the continue launches.
- [ ] `--persona` and `--write` on `/subcont` fail with a clear error and no child process; `subagent_continue` has no persona parameter and rejects write access for a persona subagent.
- [ ] `--model` and `--thinking` overrides on a continue are used and stored for the next continuation; with no override, the stored values are used.
- [ ] `--skills` on a continue adds to the persona's list for that turn and is not stored for the next turn.
- [ ] A queued continue, a failed continue that is retried, and removal of the subagent (including its persona prompt file from ticket 02) behave as for a persona-less subagent.
- [ ] A continue of a persona-less subagent passes the same arguments as before this ticket.
- [ ] No test depends on a real model. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
