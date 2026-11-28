# 05: Docs, privacy contract and manual acceptance

**What to build:** The viewer guide states exactly what the viewer now exposes and what it still excludes, documents the new endpoint, caps and section, and the docs test and leak tests keep protecting the privacy contract. A manual browser pass against the extended manual fixture is run, and only what was actually run is recorded.

Spec: `../spec.md` (user stories 38–40; Implementation Decisions: Privacy contract change, Modules touched; Testing Decisions: Leak tests split in two, Manual acceptance).

**Blocked by:** 04.

**Status:** done — merged to feature/viewer-agent-output

**Delegation tier:** light for the docs and fixtures → codex `luna` at xhigh; the orchestrator runs the browser pass and records it; Opus review at medium effort.

- [x] `docs/factory-web-viewer.md` rewords the statement that responses exclude "logs" and "internal records": Attempt output is allowed in scrubbed, bounded form; raw prompts, input briefs, tokens, endpoint paths, worker configuration, metrics, artifact paths and canonical checkout paths remain excluded. It documents the new endpoint (query rules, not-found cases), the fixed caps and the new section.
- [x] The vendor-neutral docs test is updated together with the guide and keeps its existing constant checks.
- [x] The manual fixture is extended with a node that has several attempts and a command node with output. (Done early as 05a, merged: factory `attempt-output-manual`; start with `node bootstrap/test-support/factory-viewer-manual-fixture.ts`.)
- [x] Manual acceptance: select nodes and read output at 1280px and 390px with no horizontal page scroll; keyboard-only use of the section; no CSP errors and no external requests; a node finishing during a poll shows its output without disturbing pan, zoom, selection, open sections or focus; contrast of every rendered text pair. The guide records only what was actually run and lists the rest as NOT YET RUN.
- [x] `GLOSSARY.md` still matches the **Attempt output** definition; `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge, and `spec.md` status is updated.

## Progress note (05a, fixture criterion)

The manual-fixture criterion was done ahead of the rest of this ticket as a parallel work item (branch `ticket/vao-05a`, builder codex luna xhigh, merged with `--no-ff`; commits `16540ad`, `1b4e3a9`). Two Opus review rounds (medium): round 1 one blocking (the review-loop reviewer node showed Uncertain because of placeholder handoff digests; now real digests), round 2 PASS. Viewer suite 85 passed (builder and reviewer). The fixture adds the factory `attempt-output-manual` with nodes `attempt_history` (three finished attempts, loop not finalized so parked), `attempt_review`, `command_exit` (exit 17), `command_signal` (SIGTERM), `missing_result` (Evidence unavailable), `still_running` (Not applicable), with fake paths, a bidi character and long unbroken tokens in several fields.

Carry into the manual acceptance step of this ticket:
- The only fixture advancer that finishes a node during a poll (`createLiveFixtureAdvancer`) finishes alpha `right` with a one-line summary only; to check "a node finishing during a poll shows its output" with multi-line detail, lists and outputs, extend that advancer (or add a second trigger) as part of this ticket.
- Optional review notes: assert `status_text` "Failed" and `evidence` "available" for `command_exit`, `command_signal` and `attempt_review` in `bootstrap/factory-web-viewer.test.ts`; wrong digests on the claims for attempts 1 and 2 would not show today.

## Progress note (docs, docs test and fixture advancer merged; browser pass pending)

Merged as `0c4d80a` via `ticket/vao-05` (builder commits `d06e0c5`, `24d7c03`, `cb637e7`, `a5ec995`, `f220aaa`, `983db40`, `50ff085`, `729ff1d`), four Opus review rounds (medium). Round 1: two blocking (the guide overstated the artifact-path exclusion because command stdout/stderr excerpts, spawn and termination errors, disposition reasons, error messages and causes never went through the artifact matcher; the docs test passed when "tokens", "metrics" or "artifact paths" was removed from the exclusion sentence or the old "excludes logs and internal records" claim was put back elsewhere). Round 2: one blocking (a command excerpt clipped by the runner at 999 characters plus "…" could still show part of an artifact path) and a vacuous timing test. Round 3: one blocking (the guide claimed a path cut in half by the runner is never shown, but a clip inside the first segment of a relative path is). The user chose a docs-only fix. Round 4: PASS, 3 optional docs-precision notes.

Code done in this ticket (it was a docs ticket until review round 1): the same artifact matcher now runs on command stdout/stderr excerpts, spawn and termination errors, causes, disposition reasons, error messages and the non-allowlisted signal in `/output` (not on `/live`); a runner-clipped excerpt's trailing partial token is dropped before the artifact matcher. Tests: viewer suite 102 passed (builder), 109 of 109 viewer plus docs tests in default parallel mode (reviewer, round 4); `node bootstrap/run-tests.ts deterministic` 1622 of 1625 (builder; the 3 failures are `hc-live-isolation.test.ts` inside an hc cgroup; `bootstrap/pane-wake.test.ts` has an existing load-dependent flake that passes 17 of 17 in isolation).

Ticked here: the guide rewording and the docs test. NOT ticked: the manual browser acceptance (not yet run) and the final criterion (it also requires the spec status to be updated), so this ticket stays `ready-for-agent` until the browser pass is run and recorded.

Optional docs notes left open (round 4): the "keeps a prefix of that run" sentence is true but the whole run is kept when its last 4,096 characters are not path-like; the clip trim's delimiter set differs from the artifact matcher's (`!`, `?`, `=` are not boundaries, so `key=src/a…` drops `key=` as well, and `and/or…`, `.5…`, `~ish…` are dropped, not only drive-prefix tokens); kept + omitted counts post-scrub code points.

Review files: scratchpad `review-05-r1.md` to `review-05-r4.md`, `review-05a-r1.md`, `review-05a-r2.md`.

## Final note (browser acceptance, closing the ticket)

The manual browser acceptance was run as a scripted headless Chrome 158 pass (builder agy hydrogen high, driving the DevTools protocol against the extended manual fixture; merged as `d6b9363` via `ticket/vao-06`, builder commits `538ec3f`, `7bd3cc8`, `085d6a4`, `a120d71`, `766a227`), reviewed by Opus (medium): PASS, no blocking findings. The pass found one real defect, now fixed (`<h5 class="inline">` inside each attempt `<summary>` rendered as a block with margins and pushed the status chip onto its own line at 1280 and 390px; replaced by an inline `<strong role="heading" aria-level="5">`, the Materialize guard allowlist and `style.css` unchanged, `aria-level` added to the safe-attribute list as a literal "5"). Results as recorded in the guide: reading output on every node, no horizontal page scroll (`scrollWidth === clientWidth`, 1265 or 1280 at the 1280px viewport because of the vertical scrollbar, 390 at 390px), scripted keyboard traversal of the attempt, Structured outputs and Artifacts disclosures (start node focused programmatically, then real key events), no CSP errors and no external requests (110 loopback requests), a node finishing during a poll (0 `/output` requests across 3 idle polls, 1 after the finish, no page reload, pan, zoom, selection, open disclosures and focus preserved, `aria-live="off"` on the card), contrast minimum 5.75:1 in light and dark for the audited scope, heading layout fixed, and a failed fetch confined to the section with retry on re-select.

The criterion is ticked because its own rule was met: the guide records only what was actually run. Still NOT YET RUN and listed so in the guide: a human keyboard-only session, a screen-reader check, real-device checks, and contrast of `attempt_review`, `command_signal` and alpha `left`/`right`. Open cosmetic item: the nested "Structured outputs" and "Artifacts" summaries still use block `<h6>`, so their disclosure triangle sits on its own line (apply the same inline `role="heading"` pattern at level 6 later). The announcer notes (a factory-state announcement can be overwritten by an output announcement in the same poll; a second identical announcement is not re-announced) are also still open from ticket 04b.

Review files: scratchpad `review-06-r1.md`, `browser06/RESULTS.md`, `browser06/screenshots/`.
