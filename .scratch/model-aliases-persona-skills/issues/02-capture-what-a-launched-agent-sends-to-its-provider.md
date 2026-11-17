# 02: Capture what a launched agent sends to its provider

**What to build:** A runtime test seam that launches a real bootstrapped child with the real Pi binary, captures the request it would send to its model provider, and stops it before any model call is made. A baseline test uses it to pin down today's prompt, so later tickets can prove their changes against the real thing.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Specification:** [Configurable model aliases, narrower persona discovery and allowed skills](../spec.md)

## Acceptance criteria

- [ ] A test helper launches a child through the existing runtime test suite, records the outgoing provider request and exits without contacting any provider or spending anything.
- [ ] The helper exposes, in a test-friendly form, the system prompt text and the skill names it contains.
- [ ] A baseline runtime test asserts the current behavior: every discovered skill is listed, Pi's harness-documentation block is present, and the persona text appears in front of Pi's default prompt.
- [ ] The helper works regardless of what the machine's own user configuration contains (it uses the isolated runtime environment of the existing harness and does not touch the user's trust or settings).
- [ ] The helper does not hang when the child has no terminal input.

## Verification

- Run the runtime suite with at least one fixture skill directory and confirm the captured skill names match it.
- Run the helper twice and confirm identical captured prompts for identical inputs.

## Constraints and handoff

Follow the existing harness conventions for the deterministic, runtime and live suites; this belongs to the runtime suite. Do not change production behavior in this ticket. A Pi upgrade that changes prompt wording should fail the baseline test loudly rather than pass silently.
