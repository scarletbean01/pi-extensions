# 05: `dry_run` warnings for concurrent writers in a shared checkout

**What to build:** Planning warns before launch about two kinds of misleading result in parallel graphs that share one checkout. Neither warning fails planning, and no snapshot behaviour changes.

- **Risk lanes:** if lanes are configured and two or more loop bodies (or a loop body and another writer) can run concurrently in the same shared checkout, warn. The warning names them and explains that lane snapshots cover the whole repository, so one loop's review can count another's edits and escalate. Lane snapshots stay whole-repository, and classification is unchanged.
- **Verification:** nodes declare only required check IDs, and the scope of a check is chosen when the agent records it. So if two or more concurrently runnable nodes in one shared checkout declare required checks, warn and advise recording those checks with a scope. Unscoped verification keeps its conservative whole-tree snapshot.

Spec: `../spec.md` (planning warnings decisions; user stories 35–39).

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Through `dry_run` planning output, a graph with lanes and two concurrent loop bodies in a shared checkout gets the lane warning, naming them.
- [x] A graph with two concurrently runnable nodes declaring required checks gets the verification warning.
- [x] A serial graph, a graph without lanes, and a graph without required checks get neither warning.
- [x] Planning still succeeds in every case. Lane classification and verification snapshot tests pass unchanged.
- [x] The bootstrap README's lanes and verification sections describe the warnings.
