# 03: Persona tools and skills

**What to build:** A persona subagent gets the tools and skills its persona declares. A non-empty `tools:` list is used exactly as written; no `tools:` line means the current read-only set. `--write` combined with `--persona` is rejected with a clear error. Persona `skills:` names are resolved through the widget's existing skill resolver and loaded into the subagent; an omitted or empty `skills:` means no skills, as today. A name that does not resolve fails the launch, naming the persona and the skill. `--skills` on a persona launch adds to the persona's skills for that launch. The persona's `extensions:`, `color` and `description` have no effect on a subagent.

Spec: `../spec.md` (user stories 11–18; Implementation Decisions: Tools, Skills, Ignored persona fields, Rejected combinations).

**Blocked by:** 01 (persona launch).

**Status:** ready-for-agent

**Delegation tier:** easy (argument wiring through existing seams, well specified) → codex `gpt-6-luna` at `model_reasoning_effort=xhigh`; Opus review at medium effort.

- [ ] The fake `pi` executable receives a persona's `tools:` list exactly as written; a persona without `tools:` gets the read-only set; names are passed through verbatim.
- [ ] `--write` with `--persona` fails with a clear usage error and no child process, on `/sub` and on `subagent_create` (`writeAccess` with `persona`).
- [ ] Persona skills names are loaded as `--skills` names are today; no `skills:` line and an empty one both load no skills; an unknown name fails the launch before a child starts and names the persona and the skill.
- [ ] `--skills` (or the tool's `skills`) on a persona launch adds to the persona's list for that launch only.
- [ ] A persona with `extensions:`, `color` and `description` launches a child with no extra extensions and no changed arguments from those fields.
- [ ] No test depends on a real model. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
