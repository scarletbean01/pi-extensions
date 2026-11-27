# 02: The persona's instructions reach the child

**What to build:** A persona subagent's system prompt is the persona's body followed by Pi's normal prompt with the Pi-docs section removed, as Bootstrap builds it for an agent. The child helper extension that already strips the docs section also places the persona text in front when the launch has a persona. The persona text reaches the child through the launch environment or a file the launch owns, never through the task prompt, so it cannot be mistaken for a flag or attachment. A launch with no persona leaves the prompt exactly as today.

Spec: `../spec.md` (user stories 5; Implementation Decisions: Prompt delivery; Testing Decisions: Child helper).

**Blocked by:** 01 (persona launch).

**Status:** ready-for-agent

**Delegation tier:** complex (changes the child-process contract and prompt ordering) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [ ] A unit-level test of the child helper shows the prompt order: persona text first, then Pi's base prompt with the `<docs>` section removed.
- [ ] A launch with no persona gives a prompt identical to today's, and the helper behaves as before.
- [ ] Through the harness, a persona launch hands the persona text to the child by the chosen channel, and the task prompt passed to the child contains none of it (including a persona body that starts with `-` or `@`).
- [ ] Any file the launch creates for the persona text is removed with the subagent's other session files and never outlives it; a failure to write it fails the launch before a child starts.
- [ ] No test depends on a real model. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
