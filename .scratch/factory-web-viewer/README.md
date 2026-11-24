# Factory web viewer: tickets

Specification: [spec.md](spec.md). Design: `docs/factory-web-viewer.md`. Vocabulary: `GLOSSARY.md`. Tracker: local files. Prepared 2026-11-23.

Tracks: inspect 02→03; live graph 04→05; queue/receipts 06 and requests/proposals 07 (independent). They meet at 08, then 09 and 10. Ticket 01 gates everything.

| # | Ticket | Blocked by |
| --- | --- | --- |
| 01 | [Read-only viewer skeleton with the factory list and the unchanged-state proof](issues/01-read-only-viewer-skeleton-with-factory-list-and-unchanged-state-proof.md) | None (can start immediately) |
| 02 | [Inspect snapshot for the current version](issues/02-inspect-snapshot-for-the-current-version.md) | 01 |
| 03 | [Inspect version selector and version-bound node links](issues/03-inspect-version-selector-and-version-bound-node-links.md) | 02 |
| 04 | [Live Graph snapshot for a verified released run](issues/04-live-graph-snapshot-for-a-verified-released-run.md) | 02 |
| 05 | [Live state model: idle, waiting, blocked, uncertain, ended](issues/05-live-state-model-idle-waiting-blocked-uncertain-ended.md) | 04 |
| 06 | [Queue and Receipts](issues/06-queue-and-receipts.md) | 01 |
| 07 | [Requests and Proposals](issues/07-requests-and-proposals.md) | 01 |
| 08 | [Page layer: Materialize shell, navigation and all views rendered](issues/08-page-layer-materialize-shell-navigation-and-all-views.md) | 03, 05, 06, 07 |
| 09 | [Live refresh: polling, in-place updates, stale handling and follow-next-run](issues/09-live-refresh-polling-in-place-updates-stale-handling.md) | 08 |
| 10 | [Docs and manual acceptance checklist](issues/10-docs-and-manual-acceptance-checklist.md) | 09 |
