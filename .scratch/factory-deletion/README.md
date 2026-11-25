# Factory deletion: tickets

Specification: [spec.md](spec.md). Decision: `docs/adr/0002-deleting-a-factory-retires-it.md`. Vocabulary: `GLOSSARY.md` (**Deleted factory**). Tracker: local files. Prepared 2026-11-25.

Tracks: ticket 01 gates everything. After it, 02 (then 03), 04, 05 (then 07) and 06 are independent. They meet at 08.

| # | Ticket | Blocked by |
| --- | --- | --- |
| 01 | [Delete an idle factory and see it marked deleted](issues/01-delete-an-idle-factory-and-see-it-marked-deleted.md) | None (can start immediately) |
| 02 | [Refuse deletion while work remains](issues/02-refuse-deletion-while-work-remains.md) | 01 |
| 03 | [Revalidate preconditions at commit time](issues/03-revalidate-preconditions-at-commit-time.md) | 02 |
| 04 | [A deleted factory refuses every mutation but stays readable](issues/04-deleted-factory-refuses-every-mutation-but-stays-readable.md) | 01 |
| 05 | [List `--all` and a reserved name](issues/05-list-all-and-a-reserved-name.md) | 01 |
| 06 | [Integrity: fail closed, migrate safely, leave evidence untouched](issues/06-integrity-fail-closed-migrate-safely-leave-evidence-untouched.md) | 01 |
| 07 | [Web viewer: the "Deleted" section and banner](issues/07-web-viewer-deleted-section-and-banner.md) | 01, 05 |
| 08 | [Docs and manual acceptance checklist](issues/08-docs-and-manual-acceptance-checklist.md) | 02, 03, 04, 05, 06, 07 |
