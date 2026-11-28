# 02: The rest of the recorded report: verification, warnings, next steps, command output, structured outputs

**What to build:** The Attempt output section shows everything else an attempt recorded: the verification entries, warnings and next steps the agent listed; for command nodes the exit code, signal and standard output and standard error excerpts; the structured outputs collapsed as readable pretty-printed text; artifact descriptions without their paths; and, for a node that never produced a result, its disposition reason or recorded error message. Nothing private widens: prompts, briefs, tokens, endpoint paths, worker configuration, metrics and artifact paths stay out of every response.

Spec: `../spec.md` (user stories 8–14, 31–35, 40, 41; Implementation Decisions: Fields shown per attempt, Caps (items, outputs, excerpts), Components and styling; Testing Decisions: leak tests split in two).

**Blocked by:** 01.

**Status:** done — merged to feature/viewer-agent-output

**Delegation tier:** complex (extends both the server projection and the client section; leak-test fixtures need care) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [x] Verification entries, warnings and next steps appear per attempt; each item is capped at 500 characters and each list at 20 items, with a visible marker for omitted characters and for omitted items.
- [x] For a command node the exit code, signal and the stdout and stderr excerpts (each capped at 4,000) appear next to each other, so a failed command can be explained.
- [x] Structured outputs appear in a collapsed native disclosure as pretty-printed text capped at 8,000; artifact descriptions appear with no file paths; a node with no result shows its disposition reason or the recorded error message (blocked, skipped, cancelled and failed nodes are all explained).
- [x] Metrics, tokens, endpoint paths, worker configuration, the raw input brief and its identity roster, and artifact paths never appear in the output route or in any other endpoint. Whole-body sentinel scans prove this on every endpoint including the new one.
- [x] Existing fixtures that put private sentinels into result detail and command excerpts are re-seeded so the newly allowed fields use non-private sentinels (asserted present, scrubbed and capped) while the private sentinels stay private.
- [x] Every status, chip and card panel in the section carries a symbol or word as well as colour and a complete tone class set; the accordions are native disclosures with real headings and are keyboard reachable; the Materialize guard test passes with no new allowlist entry.
- [x] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

## Verification note

Merged via `ticket/vao-02` (builder commits `f6669e4`, `ed098d6`, `70a0cac`, `608a6a7`, `c82634c`), five Opus review rounds (medium). Round 1: three blocking (the N3-b path-prefix cut still leaked; raw `completed_at`, `recorded_at`, `causes` and `signal` leaked paths and broke the 64 KB cap; an artifact's own relative path survived in its description). Round 2: three blocking, all in code added by round 1's fix (artifact-path redaction ran before generic scrubbing and leaked tails and `~user`; it was O(artifacts × text); the structured-outputs omitted count was understated). Round 3: two blocking (`path:line` forms leaked again; spaced artifact paths stalled `/output` for about 7 s). After round 3 the user approved a simplified design (multi-part artifact forms dropped from free-text matching). Round 4: one blocking (artifact path next to non-ASCII punctuation leaked). Round 5, narrow: PASS.

Tests: viewer suite `env -u HC_TERMINAL_ID -u HC_TERMINAL_SOCKET -u HC_SCOPE timeout 600 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 bootstrap/factory-web-viewer*.test.ts`: 95 passed (builder; reviewer reran); docs test 7 passed; `node bootstrap/run-tests.ts deterministic`: 1615 of 1618 (builder), the 3 failures are `hc-live-isolation.test.ts`, which cannot run inside an hc cgroup. `/live` output for valid data checked byte-identical to the pre-ticket code (reviewer, 7-stage review-loop comparison).

Done here: the shared attempt resolver (`factory/viewer/attempt-resolution.ts`, N4 and N-e from ticket 01), N3-a and N3-b, hard 64 KB response budget with a stub fallback, validated timestamps, statuses and signals on both `/output` and `/live`, bounded pretty-printing with an exact omitted count, whole-item 500-character caps, identity masking for unverified attempts, and artifact-path redaction as whole tokens (after generic path scrubbing).

Documented residuals and notes carried forward (ticket 03 unless stated):
- An artifact path that contains a space or another delimiter is not redacted from free text (the artifact's own `path` field is never returned); absolute paths are redacted by the generic scrubber only up to the first space or delimiter.
- N-a (round 5): non-ASCII numbers and modifier letters such as `src/a.ts¹`, `②`, `½`, `ʼs` (\p{No}, \p{Nl}, \p{Lm}) still extend a word and leak the artifact path; treat them as delimiters. Also strip a run of leading sigils (`@@src/a.ts`, `+src/a.ts`, `$src/a.ts`, `^src/a.ts`).
- N-b (round 5): `hasArtifactDelim` runs a regex test per code unit for every form of every artifact before the 256 KiB cap is consulted (about 300 ms for 1 MiB of artifact paths, paid per node on `/live`); use a single regex pre-check or apply the cap first.
- N-c (round 5): the docs say non-ASCII characters outside letters, numbers and marks delimit, but every supplementary-plane character, including astral letters and digits, is also treated as a delimiter; say so or iterate by code point.
- Per-attempt resolver and a response budget that spans attempts (ticket 03's work): the resolver only resolves the latest attempt and `enforceOutputResponseBudget` only knows `latest_attempt`.
- A parked loop node shows the attempt's own status in the section while the graph shows "Waiting (parked)" (documented).
- Re-rendering the section resets the open state of the "Structured outputs" and "Artifacts" disclosures on every refetch (ticket 04); the `<h5 class="inline">` inside `<summary>` may push the status chip onto its own line (check in ticket 05's browser pass).

Review files: scratchpad `review-02-r1.md` to `review-02-r5.md`.
