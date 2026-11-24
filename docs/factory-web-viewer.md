# Factory Web Viewer

A standalone, read-only local dashboard for observing factory records without Pi, Herdr, or a managing factory session. It binds only to loopback and never invokes launch, recovery, repair, reconciliation, settlement, or cleanup operations.

## Start and stop

Use Node 26+ from the extension checkout:

```sh
node factory/viewer/cli.ts
```

Or point to a specific factory state database:

```sh
FACTORY_STATE_PATH=/absolute/path/to/factories.sqlite node factory/viewer/cli.ts
```

When `FACTORY_STATE_PATH` is omitted, the viewer uses `factories.sqlite` in `PI_FACTORY_STATE_DIR` (or `PI_BOOTSTRAP_STATE_DIR`, defaulting to `~/.pi/agent/bootstrap-sessions`), matching `/factory list`. An empty `FACTORY_STATE_PATH=""` is rejected, whereas an empty `PI_FACTORY_STATE_DIR=""` matches `/factory list`'s default-path rules and resolves `./factories.sqlite` relative to the working directory. `FACTORY_VIEWER_HOST=127.0.0.1|::1` chooses the loopback address (default `127.0.0.1`) and `FACTORY_VIEWER_PORT=PORT` chooses a port (otherwise an ephemeral port is selected). Ctrl-C stops only the viewer. Keep the URL local and do not proxy it to another host.

## Views

The sidebar lists published factories. Choose one to open Live Graph, or use the view navigation for Inspect, Queue, Receipts, Requests, and Proposals. The browser displays only snapshot evidence: unknown, partial, or unavailable fields are labelled rather than guessed. Receipts are not run reports; proposals are not the active constraints file. The viewer offers no factory action controls.

Live Graph polls approximately every two seconds while selected. Verified run topology is displayed when provided by the API; missing topology is not inferred. Failed refreshes show Stale and retain the last successful snapshot, distinct from fresh uncertain evidence. The node diagram supports pointer drag and wheel zoom; node selection displays available status/reason and a bound-version configuration link when the snapshot supplies a bound version.

## Local asset/API contract

The browser currently requests exactly these local asset routes:

- `GET /` or `/index.html` — HTML shell
- `GET /style.css` — responsive local stylesheet
- `GET /app.js` — client application

No CDN, external fonts, icon service, or runtime remote asset is used. These assets are locally authored; the current stylesheet uses a Materialize-inspired layout/palette and does **not** bundle upstream Materialize CSS. Integrators should either retain this explicitly lightweight implementation or add and license/vendor Materialize locally, extend the server's static allowlist, and document its exact routes.

Snapshot routes consumed by the client are `GET /api/factories`, `/api/factories/:id/live`, `/inspect`, `/queue?filter=all`, `/receipts?reference=...`, `/requests`, and `/proposals`. The existing server's Inspect/queue/receipt/etc. projections provide mostly flat objects; live rendering accepts either top-level run fields or a nested `run`, `live_run`, plus nodes (`id` or `node_id`), edges (`from`/`source`, `to`/`target`), and feedback_edges. To fully populate the client, integration should adapt live projection to provide `state`, `reason`, `checked_at`, stable run identity (`run_id` or `task_id`), `bound_version`, `current_version`, nodes with textual `status`/optional `reason`, `edges`, `feedback_edges`, `outcome`, `settlement`, and `capacity_release`. For node Inspect links use a page route (the current route serves JSON, not HTML). Queue currently supports `entries` or `inputs`; inspect uses `definition.nodes`, `capacity`, `head_status`, `attention`, and `versions`. Requests/proposals render `records`. Missing or incompatible data remains an unavailable/empty notice, not fabricated evidence.

## Read-only and privacy

The API is GET-only, accepts factory/version/reference identifiers rather than paths, and must be backed by configured state only. Never provide filesystem paths or arbitrary query parameters. The browser does not receive raw records, prompts, full briefs, logs, or store paths. Use fixture state only when verifying; do not use this viewer to test or operate a real factory.

## Manual acceptance checklist (not automated)

These five scenarios are intentionally manual; no browser DOM tests are used. None has been exercised in this implementation environment.

1. **Older bound version:** use a fixture with a verified v2 run and v3 current; confirm the graph uses v2 topology and configuration links stay in v2.
2. **Release evidence:** check known blockers and contradictory release evidence; reserved or failed-before-release launches must not be drawn as running.
3. **Connection failure and switch:** interrupt refresh during a run, then recover; verify Stale and last-good time, clear stale on recovery, distinguish fresh Uncertain, and switch factories without showing old data.
4. **Accessibility and layout:** keyboard-only navigate all views and node links; verify focus visibility, narrow drawer open/close (including Escape), semantic headings/tables, and textual status independent of color.
5. **Live refresh continuity:** refresh the same run and verify pan, zoom, selected node, expanded content, and keyboard focus remain; verify next verified run replaces ended state.

Additionally inspect browser network activity for local-only requests/no remote fonts, and against isolated fixtures with manager closed verify viewing all routes leaves state bytes unchanged. These are manual checks, not claims of verification.
