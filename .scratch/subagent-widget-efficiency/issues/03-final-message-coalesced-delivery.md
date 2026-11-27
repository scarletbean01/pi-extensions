# 03: Final-message, coalesced and cancel-safe delivery

**What to build:** The parent hears about subagents correctly and cheaply. A finished subagent reports its last assistant message with usage (stderr only on failure, tail-truncated). While any sibling is still running, completions are held; the parent is woken once, with every result, when the last running subagent settles, and immediately when a lone subagent finishes. Removing or clearing a subagent never wakes the parent, and a subagent that ignores the polite kill is force-killed after 5 seconds. The launch tools end the parent's turn when the batch holds only launches.

Spec: `../spec.md` (user stories 7–17; Implementation Decisions: Final-message result, Coalesced completion, Cancellation, Terminate on launch).

**Blocked by:** 01 (test harness); merge after 02 so both do not edit the launch code at once

**Status:** ready-for-agent

**Delegation tier:** complex (queueing across parallel completions, cancellation races, continuation rejoining a running batch) → agy `gemini-4-hydrogen-high`; Opus review at medium effort.

- [ ] A subagent that narrates across several turns delivers only its last assistant message; a final message over the limit keeps its end and says it was cut.
- [ ] A failed subagent's result includes its stderr; a successful one does not. Each result carries token and cost totals summed across the subagent's messages.
- [ ] Three parallel subagents finishing at different times produce exactly one wake-up, after the last settles, containing all three results. A lone subagent produces one wake-up on finish.
- [ ] A subagent continued while siblings run rejoins the running set; a cancelled subagent does not hold a batch open.
- [ ] `/subrm`, `/subclear` and the remove tool never send a message or trigger a turn for the removed subagent, including when the process exits after removal. A process that ignores SIGTERM is force-killed after 5 seconds and the timer does not keep Pi alive.
- [ ] The two launch tools mark their results terminating; a test shows a batch with another non-terminating tool is unaffected by this change.
- [ ] Characterization tests from ticket 01 that pinned the old behaviour are updated deliberately. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
