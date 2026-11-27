# 04: Shutdown cleanup and session-file hygiene

**What to build:** Quitting Pi stops every running subagent, and session files no longer pile up. A session-shutdown handler stops children, clears the timer and removes the widget. A removed subagent's session file is deleted, and subagent session files older than 7 days are pruned at session start. The sessions directory is created once, asynchronously.

Spec: `../spec.md` (user stories 25–27; Implementation Decisions: Lifecycle).

**Blocked by:** 03 (shutdown must reuse the cancel-safe kill path)

**Status:** ready-for-agent

**Delegation tier:** easy (well specified, clear tests) → codex `gpt-6-luna` at `model_reasoning_effort=high`; Opus review at medium effort.

- [ ] Firing session shutdown with running subagents leaves none alive and sends no message to the parent; calling it twice is harmless.
- [ ] `/subrm`, `/subclear` and the remove tool delete the removed subagents' session files; other subagents' files stay.
- [ ] At session start, files older than 7 days in the subagent sessions directory are deleted and newer ones kept; other files in that directory, if any, are left alone.
- [ ] No synchronous directory creation remains on the launch path.
- [ ] The token benchmark's cited session file is not deleted by any of these paths unless its own subagent was removed; the benchmark README states where evidence should be copied to survive pruning.
- [ ] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
