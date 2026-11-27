# 02: Lean worker launch that keeps its model

**What to build:** A subagent starts without skills, MCP servers, prompt templates, themes or Pi docs and with read-only tools; a launch can opt in to named skills or to write access. The prompt cannot be misread as a flag, the subagent runs in the parent's working directory with the running Pi binary, and continuing a subagent keeps its original model and thinking level unless overridden. Stream framing splits only the new chunk, strips carriage returns and skips lines for events the widget ignores.

Spec: `../spec.md` (user stories 1–6, 18, 19; Implementation Decisions: Lean worker context, Continuation keeps its model, Stream handling).

**Blocked by:** 01 (test harness)

**Status:** done

**Delegation tier:** easy (flag changes and a defaulting fix, well specified) → codex `gpt-6-luna` at `model_reasoning_effort=high`; Opus review at medium effort.

- [x] The fake `pi` executable receives the lean flags (skills, MCP, prompt templates, themes, docs off), read-only tools by default, the end-of-options marker before the prompt, and the parent's working directory. A prompt starting with `-` or `@` arrives as plain text.
- [x] A launch with a skills list or the write-access flag changes only the corresponding arguments; shell and edit tools appear only with write access.
- [x] The tool schemas and command help describe both opt-ins.
- [x] `/subcont` and `subagent_continue` with no override pass the stored model and thinking level; an explicit override is used and stored for the next continuation.
- [x] Output with CRLF line endings, a line split across chunks, and large ignored-event lines all produce the same result as clean input.
- [x] No test depends on a real model. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

**Verification note:** `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget.test.ts` passed three consecutive runs (10 tests each, 0 failures); every child is the fake Pi executable. Launch assertions cover lean arguments, `ctx.cwd`, literal `-`/`@` prompts, inherited proxy/provider/custom/cache/locale environment, removal of the five Pi shell-session variables and launcher seam, named-skill resolution, write opt-ins, and command/tool continuations. A test loads the generated child extension and confirms it removes Pi's `<docs>` section while project context files remain enabled. Unknown skills and child-extension write failures report errors before spawning. Stream framing passed with CRLF, a JSON event split across chunks and a 2 MiB ignored event. `bootstrap/README.md` and `bootstrap/HOST.md` were checked and contain no stale claims about this widget.
