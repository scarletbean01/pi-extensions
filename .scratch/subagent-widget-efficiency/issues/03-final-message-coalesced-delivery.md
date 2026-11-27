# 03: Final-message, coalesced and cancel-safe delivery

**What to build:** The parent hears about subagents correctly and cheaply. A finished subagent reports its last assistant message with usage (stderr only on failure, tail-truncated). While any sibling is still running, completions are held; the parent is woken once, with every result, when the last running subagent settles, and immediately when a lone subagent finishes. Removing or clearing a subagent never wakes the parent, and a subagent that ignores the polite kill is force-killed after 5 seconds. The launch tools end the parent's turn when the batch holds only launches.

Spec: `../spec.md` (user stories 7–17; Implementation Decisions: Final-message result, Coalesced completion, Cancellation, Terminate on launch).

**Blocked by:** 01 (test harness); merge after 02 so both do not edit the launch code at once

**Status:** done

**Delegation tier:** complex (queueing across parallel completions, cancellation races, continuation rejoining a running batch) → agy `gemini-4-hydrogen-high`; Opus review at medium effort.

- [x] A subagent that narrates across several turns delivers only its last assistant message; a final message over the limit keeps its end and says it was cut.
- [x] A failed subagent's result includes its stderr; a successful one does not. Each result carries token and cost totals summed across the subagent's messages.
- [x] Three parallel subagents finishing at different times produce exactly one wake-up, after the last settles, containing all three results. A lone subagent produces one wake-up on finish.
- [x] A subagent continued while siblings run rejoins the running set; a cancelled subagent does not hold a batch open.
- [x] `/subrm`, `/subclear` and the remove tool never send a message or trigger a turn for the removed subagent, including when the process exits after removal. A process that ignores SIGTERM is force-killed after 5 seconds and the timer does not keep Pi alive.
- [x] The two launch tools mark their results terminating; a test shows a batch with another non-terminating tool is unaffected by this change.
- [x] Characterization tests from ticket 01 that pinned the old behaviour are updated deliberately. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

**Verification:** Ran `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget.test.ts` three consecutive times (18/18 passing each run) against the fake host and fake `pi` binary, verifying final-message extraction from `message_end` (including newline joining of multiple text blocks and marking assistant `errorMessage`/`stopReason === "error"` as errored even on exit 0), tail truncation over 8000 bytes, summed usage totals (`input`, `cacheRead`, `cacheWrite`, `output`, `cost`), failure-only stderr attachment capped to the last 16 KiB, coalesced single-turn delivery across parallel subagents and mid-batch continuations, silent cancellation across `/subrm`, `/subclear`, and `subagent_remove` (including queued-sibling flushing when removing the last running sibling), SIGTERM-to-SIGKILL escalation via the documented `killGraceMs` test seam (`DEFAULT_KILL_GRACE_MS = 5000`, `.unref()`, cleared on `exit`/`close`/`error`), and `terminate: true` on `subagent_create`/`subagent_continue` using the fake host's `runToolBatch` simulator of Pi's batch termination rule (`[subagent_create, subagent_list]` / `[subagent_continue, subagent_list]` keep the turn open while `[subagent_create, subagent_continue]` ends it). Verified no stray `fake-pi` processes or new `/tmp/subagent-widget-*` directories remained after runs, and checked `bootstrap/README.md` and `bootstrap/HOST.md` for stale claims (none found).
