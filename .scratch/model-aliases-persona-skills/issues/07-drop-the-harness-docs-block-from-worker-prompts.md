# 07: Drop the harness-docs block from worker prompts

**What to build:** A bootstrapped agent's system prompt no longer contains Pi's harness-documentation block, with no persona setting for it. If a later Pi version renames or removes the block, nothing is removed and the agent still runs.

**Blocked by:** 02 (provider-request capture seam)

**Status:** done — merged to main (`0e109cf`) and verified

**Specification:** [Configurable model aliases, narrower persona discovery and allowed skills](../spec.md)

## Acceptance criteria

- [x] The worker removes the harness-documentation block from the finished prompt text of every bootstrapped agent.
- [x] When the block is absent, the prompt is unchanged and no error occurs.
- [x] Prompt text and tool guidelines contributed by other extensions are not touched.
- [x] The persona text is still in front of Pi's default prompt, the bootstrap execution contract is still present, and the allowed-skills filter (when used) still applies alongside the removal.
- [x] Runtime tests using the capture seam assert the block is gone and that skills, persona text and the execution contract remain.
- [x] A deterministic test covers the absent-block case with a fixture prompt.
- [x] The baseline assertion in the runtime suite that expected the block is updated.

## Verification

- Capture-seam runtime test on a stock child, and a combined test with a limited skills list.
- Unit test of the removal on prompts with the block present, absent and malformed.

## Constraints and handoff

There is no persona or graph setting to keep the block. A worker that needs Pi's documentation reads it by path. If ticket 05 has already landed, confirm both mechanisms combine; if not, write the ticket so it works with the existing prompt-return path and merge the integration tip before reporting done.
