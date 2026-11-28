# 02: The rest of the recorded report: verification, warnings, next steps, command output, structured outputs

**What to build:** The Attempt output section shows everything else an attempt recorded: the verification entries, warnings and next steps the agent listed; for command nodes the exit code, signal and standard output and standard error excerpts; the structured outputs collapsed as readable pretty-printed text; artifact descriptions without their paths; and, for a node that never produced a result, its disposition reason or recorded error message. Nothing private widens: prompts, briefs, tokens, endpoint paths, worker configuration, metrics and artifact paths stay out of every response.

Spec: `../spec.md` (user stories 8–14, 31–35, 40, 41; Implementation Decisions: Fields shown per attempt, Caps (items, outputs, excerpts), Components and styling; Testing Decisions: leak tests split in two).

**Blocked by:** 01.

**Status:** ready-for-agent

**Delegation tier:** complex (extends both the server projection and the client section; leak-test fixtures need care) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [ ] Verification entries, warnings and next steps appear per attempt; each item is capped at 500 characters and each list at 20 items, with a visible marker for omitted characters and for omitted items.
- [ ] For a command node the exit code, signal and the stdout and stderr excerpts (each capped at 4,000) appear next to each other, so a failed command can be explained.
- [ ] Structured outputs appear in a collapsed native disclosure as pretty-printed text capped at 8,000; artifact descriptions appear with no file paths; a node with no result shows its disposition reason or the recorded error message (blocked, skipped, cancelled and failed nodes are all explained).
- [ ] Metrics, tokens, endpoint paths, worker configuration, the raw input brief and its identity roster, and artifact paths never appear in the output route or in any other endpoint. Whole-body sentinel scans prove this on every endpoint including the new one.
- [ ] Existing fixtures that put private sentinels into result detail and command excerpts are re-seeded so the newly allowed fields use non-private sentinels (asserted present, scrubbed and capped) while the private sentinels stay private.
- [ ] Every status, chip and card panel in the section carries a symbol or word as well as colour and a complete tone class set; the accordions are native disclosures with real headings and are keyboard reachable; the Materialize guard test passes with no new allowlist entry.
- [ ] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
