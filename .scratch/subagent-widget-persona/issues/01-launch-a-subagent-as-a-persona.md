# 01: Launch a subagent as a persona (model and thinking)

**What to build:** A user or the parent agent can launch a subagent as a persona: `/sub --persona <name> <task>` and an optional `persona` parameter on `subagent_create`. The persona is found the way Bootstrap finds it (project `.pi/agents`, then the global agents folder, case-insensitive). Its model (alias, full ID, or either with a thinking suffix) and thinking level choose the subagent's model and level. Precedence is explicit flag or tool parameter, then persona (suffix, then `thinking:`, then alias level), then the parent's model and level as today. A persona with no `model:` uses the parent's model. Persona levels `off`, `minimal` and `max` pass through unchanged, while the flag keeps its four values. With a persona, the tool's `thinking` parameter is optional; without one it stays required. Every persona error (unknown persona, unknown alias, invalid suffix, invalid `thinking:`) fails the launch before any child process starts, naming the persona file and field. A launch without a persona is unchanged.

Spec: `../spec.md` (user stories 1–4, 6–10, 19, 20, 28, 29; Implementation Decisions: Module boundary, Resolution result, Precedence, Thinking range, Errors, Tool schema).

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Delegation tier:** complex (new dependency from the widget on Bootstrap's shared helpers; tool schema change) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [ ] `/sub --persona <name>` and `subagent_create` with `persona` launch the fake `pi` executable with the model and thinking level the persona resolves to (alias, full ID, suffix, alias thinking, persona `thinking:`).
- [ ] A persona with no `model:` launches with the parent's model; an explicit `--model` or `--thinking` (or tool parameter) wins over the persona; the persona wins over the parent's level.
- [ ] Persona levels `off`, `minimal` and `max` reach the child unchanged; the `--thinking` flag still rejects anything outside low/medium/high/xhigh.
- [ ] `subagent_create` accepts a call with `persona` and no `thinking`, and still requires `thinking` when there is no persona. The tool description does not list personas.
- [ ] An unknown persona, unknown alias, invalid model suffix and invalid persona `thinking:` each fail before any child starts, naming the persona file and field (and where it searched, for an unknown persona). A queued launch reports the failure the way queued failures are reported today. Nothing falls back to another model.
- [ ] Project personas override global ones of the same name, case-insensitively; personas come from temporary fixtures, never the user's real folders.
- [ ] A launch with no persona produces byte-for-byte the same child arguments as before.
- [ ] Persona parsing, discovery and model resolution are reused from Bootstrap, not reimplemented. No test depends on a real model.
- [ ] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
