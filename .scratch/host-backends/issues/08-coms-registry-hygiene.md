# 08: Coms registry hygiene

**What to build:** A session's Coms registry entry stays trustworthy across heartbeats, concurrent writes and reloads.

- The keepalive keeps the start time recorded when the session started, instead of rewriting it with the current time on every heartbeat, so boot-time and process-reuse checks keep working. The heartbeat time still advances.
- Registry writes use a temporary name that is unique per process and per write, so two writers for one name cannot collide, and leftovers from a crash are never mistaken for registry entries. The working-directory name is derived portably.
- The interrupt and terminate handlers are named and removed on shutdown, so repeated reloads do not accumulate listeners.

Spec: `../spec.md` (hygiene). Tests drive behaviour from outside with a real registry directory, concurrent writers and a loaded-then-reloaded extension, as in the existing Coms reliability runtime tests.

**Blocked by:** the `coms-handoff-reliability` work merged to `main`.

**Status:** done

- [x] After several keepalive intervals (with a short test interval), the entry's start time equals the session start while its heartbeat time has advanced.
- [x] Two concurrent writers for one name never fail or leave a corrupt entry.
- [x] After a reload cycle the process's interrupt and terminate listener counts do not grow.
- [x] Existing Coms suites pass; documentation is updated if it mentions the registry fields.
