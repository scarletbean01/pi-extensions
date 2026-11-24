# 06: Queue and Receipts

**What to build:** An operator can see what is waiting, why the head cannot launch, and look up what happened to a submitted input.

**Blocked by:** 01

**Status:** done

- [x] Queue lists FIFO inputs in order with the reason the first waiting input cannot launch, if any.
- [x] The Open filter keeps unfinished and uncertain entries; All also returns finished entries.
- [x] A queue row references its receipt.
- [x] Receipt lookup by submission reference returns the admission, bound version, disposition and recorded launch attempt details where available, and is labelled as a receipt, not a run report.
- [x] An unknown submission reference is reported plainly, not as an empty receipt.
- [x] Read-only proof holds, including receipt lookup with no managing session.

## Constraints

- Specification: [spec.md](../spec.md); design: `docs/factory-web-viewer.md`; vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (the viewer observes, never drives).
- Test only through the viewer's HTTP snapshot API against fixture factory state directories, per the spec's Testing Decisions. Assert response bodies and unchanged state, never read-model internals.
- The viewer must never write, migrate, repair, reconcile, settle, launch or clean up; it must not fall through to generic standalone run status or widget paths.
- Reinspect current code first and preserve edits made by others.
