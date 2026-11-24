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

Snapshot routes consumed by the client are `GET /api/factories`, `/api/factories/:id/live`, `/inspect`, `/queue?filter=all`, `/receipts?reference=...`, `/requests`, and `/proposals`. Live rendering accepts either top-level run fields or a nested `run`, `live_run`, plus nodes (`id` or `node_id`), edges (`from`/`source`, `to`/`target`), and `feedback_edges`. Inspect returns `attention_summary` (covering `name`, `management`, `stop_state`, `current_version`, `capacity`, `queue_head`, and `attention` with operator explanations), `versions` (with `restored_from` provenance and `evidence`/`absence`), `damaged_records`, `runtime_assumptions` / `not_frozen`, `definition.nodes` (labelled configuration fields for `agent` and `command` nodes, policies, dependencies, joins, decisions, feedback targets, `required_checks`, and `limits`), and `operation_evidence` (summarising `attempts`, `admission`, `bound_versions`, `capacity`, `requests`, `proposals`, and `attention` with `detail_view`/`detail_url` references). Empty or unavailable Inspect fields use machine-readable `absence` values (`"no records"`, `"not applicable"`, `"evidence unavailable"`) with operator explanations rather than bare defaults, with these explicit exceptions: `queue_head` (from `headSummary`) omits top-level `input_id`, `reference`, and `bound_version` when `undefined` while `queue_head.input` carries the typed `absence`, `definition.limits.max_total_attempts_source` defaults to `"built-in"` when unset, and `definition.restored_from` falls back to `"not applicable"` when the inspected version is absent from `versions`. The current client assets (`factory/viewer/assets/app.js`) still use the older snapshot shape and are replaced in the page-layer ticket. Requests/proposals render `records`. Missing or incompatible data remains an unavailable/empty notice, not fabricated evidence.

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

## Verification

Run the automated viewer tests with `--test-force-exit` so any leaking-server regression fails cleanly instead of hanging:

```sh
node --test --experimental-strip-types --test-force-exit --test-timeout=60000 bootstrap/factory-web-viewer*.test.ts
```
