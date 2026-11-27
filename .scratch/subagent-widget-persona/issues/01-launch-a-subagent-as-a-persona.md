# 01: Launch a subagent as a persona (model and thinking)

**What to build:** A user or the parent agent can launch a subagent as a persona: `/sub --persona <name> <task>` and an optional `persona` parameter on `subagent_create`. The persona is found the way Bootstrap finds it (project `.pi/agents`, then the global agents folder, case-insensitive). Its model (alias, full ID, or either with a thinking suffix) and thinking level choose the subagent's model and level. Precedence is explicit flag or tool parameter, then persona (suffix, then `thinking:`, then alias level), then the parent's model and level as today. A persona with no `model:` uses the parent's model. Persona levels `off`, `minimal` and `max` pass through unchanged, while the flag keeps its four values. With a persona, the tool's `thinking` parameter is optional; without one it stays required. Every persona error (unknown persona, unknown alias, invalid suffix, invalid `thinking:`) fails the launch before any child process starts, naming the persona file and field. A launch without a persona is unchanged.

Spec: `../spec.md` (user stories 1–4, 6–10, 19, 20, 28, 29; Implementation Decisions: Module boundary, Resolution result, Precedence, Thinking range, Errors, Tool schema).

**Blocked by:** None (can start immediately).

**Status:** done — merged to feature/subagent-widget-persona

**Delegation tier:** complex (new dependency from the widget on Bootstrap's shared helpers; tool schema change) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [x] `/sub --persona <name>` and `subagent_create` with `persona` launch the fake `pi` executable with the model and thinking level the persona resolves to (alias, full ID, suffix, alias thinking, persona `thinking:`).
- [x] A persona with no `model:` launches with the parent's model; an explicit `--model` or `--thinking` (or tool parameter) wins over the persona; the persona wins over the parent's level.
- [x] Persona levels `off`, `minimal` and `max` reach the child unchanged; the `--thinking` flag still rejects anything outside low/medium/high/xhigh.
- [x] `subagent_create` accepts a call with `persona` and no `thinking`, and still requires `thinking` when there is no persona. The tool description does not list personas.
- [x] An unknown persona, unknown alias, invalid model suffix and invalid persona `thinking:` each fail before any child starts, naming the persona file and field (and where it searched, for an unknown persona). A queued launch reports the failure the way queued failures are reported today. Nothing falls back to another model.
- [x] Project personas override global ones of the same name, case-insensitively; personas come from temporary fixtures, never the user's real folders.
- [x] A launch with no persona produces byte-for-byte the same child arguments as before.
- [x] Persona parsing, discovery and model resolution are reused from Bootstrap, not reimplemented. No test depends on a real model.
- [x] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

## Verification note

Merged as `523bdba` via `ticket/persona-01`, review round 1 (Opus, medium): no blocking findings. Widget suite `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget/subagent-widget.test.ts`: 71 passed (builder and reviewer). `timeout 900 node bootstrap/run-tests.ts deterministic`: 1600 passed (builder).

Notes carried forward:
- Criterion 4: the `thinking` requirement without a persona is enforced at runtime, not in the JSON schema (a flat schema cannot express it).
- A persona with no `model:` and a parent with no model uses the widget's existing fallback model, as persona-less launches do today. Ticket 06 documents this.
- An unknown alias fails the launch even when `--model` overrides it. Ticket 06 documents this.
- Ticket 06 must also say which persona fields apply (README line at `bootstrap/README.md:38` is broad) and add `--persona` to the widget header usage comment.
- Non-blocking review items left open: weak `off/minimal/max` rejection assertion (notifications not reset per iteration), no test for a persona file edited while queued, `persona: null` reaches `.trim()`, `SpawnOptions.persona` unused. Review: scratchpad `review-01-r1.md`.
