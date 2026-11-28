# 05: Docs, privacy contract and manual acceptance

**What to build:** The viewer guide states exactly what the viewer now exposes and what it still excludes, documents the new endpoint, caps and section, and the docs test and leak tests keep protecting the privacy contract. A manual browser pass against the extended manual fixture is run, and only what was actually run is recorded.

Spec: `../spec.md` (user stories 38–40; Implementation Decisions: Privacy contract change, Modules touched; Testing Decisions: Leak tests split in two, Manual acceptance).

**Blocked by:** 04.

**Status:** ready-for-agent

**Delegation tier:** light for the docs and fixtures → codex `luna` at xhigh; the orchestrator runs the browser pass and records it; Opus review at medium effort.

- [ ] `docs/factory-web-viewer.md` rewords the statement that responses exclude "logs" and "internal records": Attempt output is allowed in scrubbed, bounded form; raw prompts, input briefs, tokens, endpoint paths, worker configuration, metrics, artifact paths and canonical checkout paths remain excluded. It documents the new endpoint (query rules, not-found cases), the fixed caps and the new section.
- [ ] The vendor-neutral docs test is updated together with the guide and keeps its existing constant checks.
- [ ] The manual fixture is extended with a node that has several attempts and a command node with output.
- [ ] Manual acceptance: select nodes and read output at 1280px and 390px with no horizontal page scroll; keyboard-only use of the section; no CSP errors and no external requests; a node finishing during a poll shows its output without disturbing pan, zoom, selection, open sections or focus; contrast of every rendered text pair. The guide records only what was actually run and lists the rest as NOT YET RUN.
- [ ] `GLOSSARY.md` still matches the **Attempt output** definition; `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge, and `spec.md` status is updated.
