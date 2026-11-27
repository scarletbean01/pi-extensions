# 06: Management tools only while subagents exist

**What to build:** The list, continue and remove tools are inactive until a subagent exists, and are switched off again when the last is removed, by adding and removing only these names from the active tool set. Descriptions are shortened and no longer duplicated. The saving is measured; if it is under about 150 tokens per parent turn, the change is reverted and this ticket is closed with the measurement recorded.

Spec: `../spec.md` (user stories 20, 21; Implementation Decisions: Lazy management tools).

**Blocked by:** 03 (settled and removed states drive the switch), 04 (reload and shutdown reset)

**Status:** ready-for-agent

**Delegation tier:** easy (small, well specified, measured) → codex `gpt-6-luna` at `model_reasoning_effort=high`; Opus review at medium effort.

- [ ] At session start only the create tool is active; after the first launch the other three are active; after the last subagent is removed or cleared they are inactive again.
- [ ] Tools belonging to other extensions that are active before a switch are still active after it, and tools another extension deactivated stay deactivated.
- [ ] A reload or new session starts from the inactive state regardless of the earlier state.
- [ ] The per-turn input-token difference with zero subagents is measured before and after and recorded in `docs/token-benchmark/README.md` with the method. If it is under about 150 tokens, the activation change is reverted, the shortened descriptions may stay, and the outcome is recorded.
- [ ] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
