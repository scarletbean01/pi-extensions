# 07: Requests and Proposals

**What to build:** An operator can see what the factory is asking and what it has proposed to learn, without any way to act on either.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Requests lists direction and exhaustion requests with question and choices where available, with response recorded and response consumed as separate observations, and any uncertainty.
- [ ] Proposals lists learned constraint proposals with provenance, outcomes and file sync state where available, and is not presented as the active constraints file.
- [ ] Neither view exposes an action, and no endpoint exists for respond, wake, review, approval or resolution.
- [ ] Read-only proof holds.

## Constraints

- Specification: [spec.md](../spec.md); design: `docs/factory-web-viewer.md`; vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (the viewer observes, never drives).
- Test only through the viewer's HTTP snapshot API against fixture factory state directories, per the spec's Testing Decisions. Assert response bodies and unchanged state, never read-model internals.
- The viewer must never write, migrate, repair, reconcile, settle, launch or clean up; it must not fall through to generic standalone run status or widget paths.
- Reinspect current code first and preserve edits made by others.
