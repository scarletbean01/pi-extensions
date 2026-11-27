# 04: Shutdown cleanup and session-file hygiene

**What to build:** Quitting Pi stops every running subagent, and session files no longer pile up. A session-shutdown handler stops children, clears the timer and removes the widget. A removed subagent's session file is deleted, and subagent session files older than 7 days are pruned at session start. The sessions directory is created once, asynchronously.

Spec: `../spec.md` (user stories 25–27; Implementation Decisions: Lifecycle).

**Blocked by:** 03 (shutdown must reuse the cancel-safe kill path)

**Status:** done

**Delegation tier:** easy (well specified, clear tests) → codex `gpt-6-luna` at `model_reasoning_effort=high`; Opus review at medium effort.

- [x] Firing session shutdown with running subagents leaves none alive and sends no message to the parent; calling it twice is harmless.
- [x] `/subrm`, `/subclear` and the remove tool delete the removed subagents' session files; other subagents' files stay.
- [x] At session start, files older than 7 days in the subagent sessions directory are deleted and newer ones kept; other files in that directory, if any, are left alone.
- [x] No synchronous directory creation remains on the launch path.
- [x] The token benchmark's cited session file is not deleted by any of these paths unless its own subagent was removed; the benchmark README states where evidence should be copied to survive pruning.
- [x] `bootstrap/README.md` and `bootstrap/HOST.md` were checked; no stale cleanup or session-file claims were found.

## Verification

- Rebased on `main` after ticket 06. Shutdown also syncs the management tools to the empty-subagent state while preserving other extensions' active and inactive tools, and skips redundant active-set writes.
- `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget.test.ts` passed three consecutive runs with `HOME` set to a throwaway probe home (54 tests per run).
- A 10-day-old `subagent-0-0.jsonl` in the probe home survived all three runs. The real `~/.pi/agent/sessions/subagents` `ls -la --time-style=full-iso` listing matched before and after; the probe home was removed after verification.
- Every harness host injects a fake sessions directory, and session lifecycle emits run with the fake Pi environment. Shutdown exits on child `exit`/`close` and has a `killGraceMs + 1000ms` upper bound; the background stdout-holder regression passed.
- A quit or reload can wait through the SIGTERM grace period (5 seconds by default) for a child that ignores SIGTERM.
- Regression tests cover concurrent create/removal, continuation removal during directory setup, cancellation before deferred pruning, and pruning symlinks without following their targets.
- `pgrep -af '[f]ake-pi'` returned no child processes; `ls /tmp | grep subagent-widget` returned no entries after removing the intentional probe home.
- `git diff --check` passed.
