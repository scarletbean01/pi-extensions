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

Snapshot routes consumed by the client are `GET /api/factories`, `/api/factories/:id/live`, `/inspect`, `/queue?filter=all`, `/receipts?reference=...`, `/requests`, and `/proposals`.

Live Graph (`GET /api/factories/:id/live`) verifies the selected factory's binding, capacity holds, and release evidence without calling generic standalone run status or widget paths (the reader passes only passive preflight and raw non-release evidence verifiers, never `status`, `statusWithCleanup`, or `settlementObservations`). Every snapshot carries `factory_id`, `current_version`, `checked_at`, `run` (`{ run_id, attempt_id, bound_version }` or `null`), `state` from the closed set (`"running" | "ended" | "idle" | "waiting" | "blocked" | "uncertain"`), and `reason`; failing store or coordination reads return HTTP `503` (`{ error: "Evidence unavailable" }`) or `404` for an unknown factory, never a fabricated snapshot. A verified released run returns `state` (`"running"` when incomplete/needs attention, or `"ended"` once all nodes have terminal outcomes—never `"running"` after ending), `current_version` separately from `run`, distinct `outcome`, `settlement` (`"unsettled"` while active/unsettled), and `capacity_release` (`"held"`), plus `graph` (`evidence: "available"`, `bound_version`, `topology`, `nodes`, `edges`, `joins`, `feedback_edges`) drawn strictly from the run's bound definition version. Dependency edges carry `kind: "dependency"`, `dependency_policy`, and derived `state` (`"pending" | "fired" | "dead"`); joins appear on `node.join` and in `graph.joins` (with `source_links`); feedback edges appear in `graph.edges` (`kind: "feedback"`) and `graph.feedback_edges` (with `target_link`). Each node carries `status`, human-readable `status_text` (e.g. `"Waiting"`, `"Waiting (parked)"`, `"Blocked"`, `"Uncertain"`), `reason` where evidence gives one, `current_attempt` details (excluding prompts, briefs, logs, and filesystem paths), `configuration_url`, and version-bound `configuration_link` (`nodeLink` in the bound version). Settled or operator-cleared historical runs (when no active unreleased launch holds capacity) return `state: "ended"`, `run` metadata, distinct `outcome`, `settlement` (`"settled"` for settled; `"unknown"`/`"unsettled"` for cleared), `capacity_release: "released"`, and `graph: { evidence: "not applicable", absence: "not applicable", explanation }`. When no released run is mounted (idle, waiting, or blocked—including `reserved` or `failed_before_release` launches), the snapshot returns `run: null`, `head_status` (from `headSummary`, explaining launch eligibility and `blocking_kind` blockers such as `empty`, `unmanaged`, `stopped`, `preflight`, `compatibility`, `ceiling`, `factory_held`, `checkout_held`, plus `without_control_fence`), and `graph: { evidence: "not applicable", absence, explanation }` (unmanaged factories and unreleased launches use `absence: "not applicable"`, while managed factories with no attempt use `absence: "no records"`). Missing, damaged, or contradictory release, binding, topology, control, settlement, or capacity evidence (including a damaged bound version while `current_version` is intact) returns `state: "uncertain"`, `run: null`, and `graph: { evidence: "unavailable", absence: "evidence unavailable", explanation }` without falling back to `current_version`. Live rendering in the legacy client still accepts either top-level run fields or a nested `run`, `live_run`, plus nodes (`id` or `node_id`), edges (`from`/`source`, `to`/`target`), and `feedback_edges`.

In review loops, if a node's progress file still reflects an earlier attempt that never recorded `"completed"` (for example, the worker died before its 5-second heartbeat after finishing attempt N while attempt N+1 was already reserved), Live Graph shows that node as `Uncertain` rather than `Blocked`: this is fail-closed by design so stale progress from an incomplete prior attempt is never silently treated as healthy for the new attempt.

Viewer-owned JSON reads use `O_NONBLOCK | O_NOFOLLOW` with `fstat` regular-file verification, and handoff paths are pre-checked with `O_NONBLOCK | O_NOFOLLOW` and `fstat` before invoking shared `describeHandoff` readers (pre-checking both edge claim and join claim source-attempt result paths whenever present so an invalid edge claim cannot bypass regular-file verification on `describeHandoff`'s join-claim fallback). A residual time-of-check/time-of-use gap remains between that pre-check and `describeHandoff`'s path-based read in `bootstrap/handoff.ts`: if a regular handoff file were swapped for a FIFO in that window, reading it could still block, though exploiting this requires local write access to the session directory and is outside the viewer's threat model.

Inspect (`GET /api/factories/:id/inspect`, accepting optional identifier-only `version`, `node`, and `factory` query parameters without duplicate keys; non-safe-integer or malformed `version` values return HTTP 400) returns `attention_summary` (covering `name`, `management`, `stop_state`, `current_version`, `capacity`, `queue_head`, and `attention` with operator explanations), `versions` (with `restored_from` provenance and `evidence`/`absence`), `damaged_records`, `runtime_assumptions` / `not_frozen`, `definition.nodes` (labelled configuration fields for `agent` and `command` nodes, policies, dependencies, joins, decisions, feedback targets, `required_checks`, and `limits`), and `operation_evidence` (summarising `attempts`, `admission`, `bound_versions`, `capacity`, `requests`, `proposals`, and `attention` with `detail_view`/`detail_url` references). Selecting a retained `version` updates `inspected_version`, `versions[*].inspected`, and `definition` to that version while keeping `current_version`, `current_definition`, `attention_summary`, `capacity`, `queue_head`, `attention`, and `operation_evidence` current; when the requested version is damaged or not retained, `definition` reports `evidence: "unavailable"` and `absence: "evidence unavailable"` without falling back to the current version. Verified node references in `dependencies.items`, `join.sources`, `policies.join.sources`, `decision` (`feedback_target_link`, `loop_body_links`), `feedback_target`, and `relationships` emit version-bound link objects (`factory_id`, `version`, `node_id`, `anchor`, `href`, `snapshot_url`), while unverified targets emit `{ absence: "evidence unavailable", explanation }` non-links; `decision.feedback_target` is a node-ID string when verified and an `{ absence: "evidence unavailable", explanation }` object when not. Passing `node` (and optionally `factory`) resolves `target_node` in the inspected version (`verified: true` with `node`, or `verified: false` with `absence: "evidence unavailable"` and an explanation when the node is unknown, the version is damaged or not retained, or `factory` does not match—never another version's configuration and never a redirect); passing matching `factory` without `node` returns `target_node` with `verified: true` and no `node`. Empty or unavailable Inspect fields use machine-readable `absence` values (`"no records"`, `"not applicable"`, `"evidence unavailable"`) with operator explanations rather than bare defaults, with these explicit exceptions: `queue_head` (from `headSummary`) omits top-level `input_id`, `reference`, and `bound_version` when `undefined` while `queue_head.input` carries the typed `absence`, `definition.limits.max_total_attempts_source` defaults to `"built-in"` when unset, and `definition.restored_from` falls back to `"not applicable"` when the inspected version is absent from `versions`. The current client assets (`factory/viewer/assets/app.js`) still use the older snapshot shape and are replaced in the page-layer ticket. Requests/proposals render `records`. Missing or incompatible data remains an unavailable/empty notice, not fabricated evidence.

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
