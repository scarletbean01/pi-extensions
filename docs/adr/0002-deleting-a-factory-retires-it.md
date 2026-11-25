# Deleting a factory retires it instead of purging it

Deleting a software factory marks it as a **Deleted factory** (a new `factory_deletions` record, timestamp and managing-session identity only) and leaves every existing row, definition version, receipt and run artifact in place. We rejected purging its rows because receipts and the version bound to each run are the evidence operators rely on after the fact, and because factory definition versions are already never deleted or rewound. The name stays reserved by the existing unique constraint, and there is no undelete.

Deletion also refuses, with no force option, while the factory has a capacity hold, an unsettled run, uncertain evidence, a pending request, a pending constraint proposal, or any queued input still eligible to launch. The operator settles, clears or discards first, so deletion never drops work or resolves uncertainty as a side effect. All preconditions are revalidated at commit time inside the fenced transaction, so a concurrent submission cannot slip past it.

## Consequences

- Read-only commands, the `factory_inspect` tool and the web viewer keep working on a deleted factory; every mutating command refuses it. It is hidden from the default listing and shown with `--all` (and in a collapsed "Deleted" section in the web viewer).
- Adding `factory_deletions` bumps the factory storage schema version from 12 to 13. Older builds use an exact version allowlist and refuse **any** v13 database (not only one that contains a deletion). The first explicit write path of the new build (`resume`, `publish`, a confirmed `delete`, etc.) migrates a v12 database to v13 and locks older builds out; read-only paths (`inspect`, `list`, the web viewer, a declined delete) never migrate.
- A damaged deletion record fails closed everywhere (mutations refused, reads report `"deletion evidence mismatch"`, and CLI/tool lists fail closed), while the web viewer's factory list isolates the damaged row into a "Damaged / uncertain" group so healthy factories stay visible.
