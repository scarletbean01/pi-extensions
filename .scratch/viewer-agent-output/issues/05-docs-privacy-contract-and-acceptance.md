# 05: Docs, privacy contract and manual acceptance

**What to build:** The viewer guide states exactly what the viewer now exposes and what it still excludes, documents the new endpoint, caps and section, and the docs test and leak tests keep protecting the privacy contract. A manual browser pass against the extended manual fixture is run, and only what was actually run is recorded.

Spec: `../spec.md` (user stories 38–40; Implementation Decisions: Privacy contract change, Modules touched; Testing Decisions: Leak tests split in two, Manual acceptance).

**Blocked by:** 04.

**Status:** ready-for-agent

**Delegation tier:** light for the docs and fixtures → codex `luna` at xhigh; the orchestrator runs the browser pass and records it; Opus review at medium effort.

- [ ] `docs/factory-web-viewer.md` rewords the statement that responses exclude "logs" and "internal records": Attempt output is allowed in scrubbed, bounded form; raw prompts, input briefs, tokens, endpoint paths, worker configuration, metrics, artifact paths and canonical checkout paths remain excluded. It documents the new endpoint (query rules, not-found cases), the fixed caps and the new section.
- [ ] The vendor-neutral docs test is updated together with the guide and keeps its existing constant checks.
- [x] The manual fixture is extended with a node that has several attempts and a command node with output. (Done early as 05a, merged: factory `attempt-output-manual`; start with `node bootstrap/test-support/factory-viewer-manual-fixture.ts`.)
- [ ] Manual acceptance: select nodes and read output at 1280px and 390px with no horizontal page scroll; keyboard-only use of the section; no CSP errors and no external requests; a node finishing during a poll shows its output without disturbing pan, zoom, selection, open sections or focus; contrast of every rendered text pair. The guide records only what was actually run and lists the rest as NOT YET RUN.
- [ ] `GLOSSARY.md` still matches the **Attempt output** definition; `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge, and `spec.md` status is updated.

## Progress note (05a, fixture criterion)

The manual-fixture criterion was done ahead of the rest of this ticket as a parallel work item (branch `ticket/vao-05a`, builder codex luna xhigh, merged with `--no-ff`; commits `16540ad`, `1b4e3a9`). Two Opus review rounds (medium): round 1 one blocking (the review-loop reviewer node showed Uncertain because of placeholder handoff digests; now real digests), round 2 PASS. Viewer suite 85 passed (builder and reviewer). The fixture adds the factory `attempt-output-manual` with nodes `attempt_history` (three finished attempts, loop not finalized so parked), `attempt_review`, `command_exit` (exit 17), `command_signal` (SIGTERM), `missing_result` (Evidence unavailable), `still_running` (Not applicable), with fake paths, a bidi character and long unbroken tokens in several fields.

Carry into the manual acceptance step of this ticket:
- The only fixture advancer that finishes a node during a poll (`createLiveFixtureAdvancer`) finishes alpha `right` with a one-line summary only; to check "a node finishing during a poll shows its output" with multi-line detail, lists and outputs, extend that advancer (or add a second trigger) as part of this ticket.
- Optional review notes: assert `status_text` "Failed" and `evidence` "available" for `command_exit`, `command_signal` and `attempt_review` in `bootstrap/factory-web-viewer.test.ts`; wrong digests on the claims for attempts 1 and 2 would not show today.
