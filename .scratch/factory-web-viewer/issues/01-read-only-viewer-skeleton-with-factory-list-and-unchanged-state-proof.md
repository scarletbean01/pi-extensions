# 01: Read-only viewer skeleton with the factory list and the unchanged-state proof

**What to build:** One terminal command starts a loopback-only viewer and prints its URL. `GET` returns the factory list for the configured state directory, matching `/factory list`, with names, current versions and recorded management state where available. A bare page shell and locally served assets load with no external requests. The fixture helper that snapshots the whole state directory and asserts it is unchanged after a sequence of requests is built here for every later ticket to reuse.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The command starts the viewer without Pi, Herdr or a managing factory session, prints a loopback URL, and the viewer listens on loopback only.
- [x] The factory list matches `/factory list` for the same state directory and never shows other directories or hosts.
- [x] Non-`GET` methods are rejected, and filesystem paths or arbitrary identifiers supplied by the client cannot read outside the configured state.
- [x] A reusable test helper proves fixture state is byte-for-byte unchanged, with no Herdr call, launch, settlement or cleanup, after starting the viewer and loading the list repeatedly, including with the manager closed.
- [x] Stopping the viewer affects only the viewer.

## Constraints

- Specification: [spec.md](../spec.md); design: `docs/factory-web-viewer.md`; vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (the viewer observes, never drives).
- Test only through the viewer's HTTP snapshot API against fixture factory state directories, per the spec's Testing Decisions. Assert response bodies and unchanged state, never read-model internals.
- The viewer must never write, migrate, repair, reconcile, settle, launch or clean up; it must not fall through to generic standalone run status or widget paths.
- Reinspect current code first and preserve edits made by others.
