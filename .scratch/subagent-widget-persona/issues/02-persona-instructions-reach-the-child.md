# 02: The persona's instructions reach the child

**What to build:** A persona subagent's system prompt is the persona's body followed by Pi's normal prompt with the Pi-docs section removed, as Bootstrap builds it for an agent. The child helper extension that already strips the docs section also places the persona text in front when the launch has a persona. The persona text reaches the child through the launch environment or a file the launch owns, never through the task prompt, so it cannot be mistaken for a flag or attachment. A launch with no persona leaves the prompt exactly as today.

Spec: `../spec.md` (user stories 5; Implementation Decisions: Prompt delivery; Testing Decisions: Child helper).

**Blocked by:** 01 (persona launch).

**Status:** done — merged to feature/subagent-widget-persona

**Delegation tier:** complex (changes the child-process contract and prompt ordering) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [x] A unit-level test of the child helper shows the prompt order: persona text first, then Pi's base prompt with the `<docs>` section removed.
- [x] A launch with no persona gives a prompt identical to today's, and the helper behaves as before.
- [x] Through the harness, a persona launch hands the persona text to the child by the chosen channel, and the task prompt passed to the child contains none of it (including a persona body that starts with `-` or `@`).
- [x] Any file the launch creates for the persona text is removed with the subagent's other session files and never outlives it; a failure to write it fails the launch before a child starts.
- [x] No test depends on a real model. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

## Verification note

Merged as `8aced22` via `ticket/persona-02`, review round 1 (Opus, medium): no blocking findings. Widget suite `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget/subagent-widget.test.ts`: 74 passed (builder and reviewer). `timeout 900 node bootstrap/run-tests.ts deterministic`: 1600 passed (builder). Delivery is by the `PI_SUBAGENT_PERSONA_PROMPT` environment variable (no file); the child helper prepends it after removing the Pi-docs section.

Non-blocking review items left open (review: scratchpad `review-02-r1.md`):
- The persona text stays in the child Pi's environment, so every tool subprocess the subagent runs inherits it. Fix: the helper captures the value and deletes it from `process.env`.
- The helper's `<docs>` regex is not Bootstrap's anchored `piHarnessDocs` match; a user `<docs>` block earlier in the prompt could be stripped instead of Pi's.
- An oversized persona body (over about 128 KiB on Linux) or a NUL gives a raw spawn error (`E2BIG`) rather than a persona-file error.
- No test shows a continue turn re-sending the persona env (ticket 04 owns continuation).

## Follow-up (merged as `ticket/persona-02b`, commit `00fc60f`)

Closed the first three open items above and added a continue-turn guard test: the helper captures `PI_SUBAGENT_PERSONA_PROMPT` once and deletes it from the child's environment; Pi's docs section is matched by Bootstrap's own pattern, now shared from `bootstrap/pi-harness-docs.mjs`; a persona body containing NUL or over 100 KiB (UTF-8 bytes) fails the launch naming the persona file and `"body"`. Review (Opus, medium): no blocking findings. Widget suite 78 passed on the merged code. Bootstrap deterministic: 1599 of 1600, the one failure being the known flaky `pane-wake.test.ts` cross-process test, which passed alone on rerun.

Non-blocking items left open (review: scratchpad `review-02b-r1.md`):
- No test proves the 100 KiB limit counts bytes rather than characters (add a rejected `"é".repeat(51201)` case).
- The shared docs pattern requires a forward-slash `README.md` path, so on Windows Pi's docs would no longer be stripped (Bootstrap already behaved this way). Allow `[\\/]` in the pattern if Windows matters.
- The helper now imports `../bootstrap/pi-harness-docs.mjs`; if that ever failed to load, the child Pi logs a stderr line and runs with no persona. Optionally check the file is readable before spawning, as `lifecycle.ts` does for `command-runner.ts`.
