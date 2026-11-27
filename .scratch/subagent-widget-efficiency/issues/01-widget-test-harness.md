# 01: Test harness for the subagent widget

**What to build:** A repeatable way to drive the subagent widget end to end without a real model: a fake host that loads the extension and records its registered tools, commands, UI calls and sent messages, plus a fake `pi` executable placed first on the search path that prints scripted JSON events, stderr and an exit code. Characterization tests pin today's behaviour (launch, result delivery, `/subrm`, `/subcont`) so later tickets change it deliberately.

Spec: `../spec.md` (Testing Decisions; user story 28).

**Blocked by:** None (can start immediately)

**Status:** done

**Delegation tier:** easy (well specified, test-only) → codex `gpt-6-luna` at `model_reasoning_effort=high`; Opus review at medium effort. Risk: the extension imports Pi packages that may not resolve under plain `node --test`. Resolve with a loader or stub rather than editing the extension's behaviour.

- [x] A test can launch a subagent through both the `/sub` command and the `subagent_create` tool against the fake `pi` executable and observe the sent result message.
- [x] The fake executable records the arguments, working directory and environment it was started with, so later tickets can assert on them.
- [x] Characterization tests cover: result delivery after a normal exit, an error exit, `/subcont` reuse of the session file, and `/subrm` killing a running subagent. Tests that pin behaviour later tickets will change are marked so they are easy to find.
- [x] Tests run with `node --test --experimental-strip-types --test-force-exit --test-timeout=60000` under `timeout`, leave no child processes behind, and write nothing outside a temp directory (the sessions directory is redirected).
- [x] No behaviour change to the extension. `bootstrap/README.md` and `bootstrap/HOST.md` were checked and contain no stale subagent-widget claims.

**Verification note:** `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget.test.ts` passed (4 tests, 0 failures). Each test uses a temporary root for the fake executable, fake HOME and session directory; `/subrm` waits for the recorded child PID to exit. The only observed current behavior called out for a later ticket is that a SIGTERM close currently sends a result message. Review fixes were verified with five consecutive passing runs, then `pgrep -af '[f]ake-pi'` found no leftover fake subprocesses; cwd and SIGTERM assertions are marked for the upcoming behavior changes.
