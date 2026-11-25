# Factory Web Viewer

A standalone, read-only local dashboard for observing software factory records without Pi, Herdr, or a managing factory session. It binds only to loopback, exposes no mutating controls, and never invokes launch, recovery, repair, store reconciliation, settlement, or cleanup operations.

This document consolidates the Factory Web Viewer design and operating guide. Architecture follows [ADR 0001](adr/0001-agents-drive-graph-execution.md) (agents drive graph execution; the viewer observes and never drives), vocabulary follows [GLOSSARY.md](../GLOSSARY.md) (**Run graph**), and Pi-side operations remain in the [Software Factory Operating Guide](factory-guide.md).

---

## 1. Starting and stopping

Start the viewer from the extension checkout with Node 26+:

```sh
node factory/viewer/cli.ts
```

To point `cli.ts` at an isolated factory fixture without reading `~/.pi/agent`, override the factory store, coordination DB, bootstrap session index, and `HOME`:

```sh
FACTORY_STATE_PATH=/tmp/fixture/factories.sqlite \
PI_FACTORY_COORDINATION_DIR=/tmp/fixture \
PI_BOOTSTRAP_STATE_DIR=/tmp/fixture/bootstrap-sessions \
HOME=/tmp/fixture/home \
node factory/viewer/cli.ts
```

`FACTORY_STATE_PATH` moves **only** the factory store (`factories.sqlite`). Because `cli.ts` does not pass `coordinationPath`, `env`, or `home` overrides to `startViewer`, `BootstrapService` still resolves the coordination database from `PI_FACTORY_COORDINATION_DIR` (default `~/.pi/agent/factory-coordination.sqlite`) and the bootstrap session index from `PI_BOOTSTRAP_STATE_DIR` (default `~/.pi/agent/bootstrap-sessions`). Setting `FACTORY_STATE_PATH` alone against an isolated fixture therefore still reads the coordination DB and session index from the real home (`~/.pi/agent`), so states can be wrong or `uncertain` (for example, `alpha` and `beta` showing `uncertain` because their sessions are missing from the real home, and `delta` showing `idle` instead of `blocked`).

Environment variables and defaults (`cli.ts` / `server.ts`):

| Variable | Default | Rules |
| --- | --- | --- |
| `FACTORY_STATE_PATH` | `factories.sqlite` in `PI_FACTORY_STATE_DIR ?? PI_BOOTSTRAP_STATE_DIR ?? ~/.pi/agent/bootstrap-sessions` | Moves only the factory store (`factories.sqlite`). Matches `/factory list`. An empty `FACTORY_STATE_PATH=""` is rejected (exit code `2`), whereas `PI_FACTORY_STATE_DIR=""` matches `/factory list` and resolves `./factories.sqlite` relative to the working directory. |
| `PI_FACTORY_STATE_DIR` | Unset (falls back to `PI_BOOTSTRAP_STATE_DIR`) | Directory containing `factories.sqlite` when `FACTORY_STATE_PATH` is unset. |
| `PI_BOOTSTRAP_STATE_DIR` | `~/.pi/agent/bootstrap-sessions` | Bootstrap session index directory (`bootstrap.store.indexRoot`) and fallback directory for `factories.sqlite`. |
| `PI_FACTORY_COORDINATION_DIR` | `~/.pi/agent` | Directory containing `factory-coordination.sqlite` (`defaultCoordinationPath()`). Set to a temp dir when inspecting isolated fixtures. |
| `HOME` | OS user home directory | Base for default `~/.pi/agent` paths when `PI_FACTORY_COORDINATION_DIR` / `PI_BOOTSTRAP_STATE_DIR` / `PI_FACTORY_STATE_DIR` are unset. |
| `FACTORY_VIEWER_HOST` | `127.0.0.1` | Loopback only: `"127.0.0.1"` or `"::1"`. Any other host throws and refuses to start. |
| `FACTORY_VIEWER_PORT` | `0` (ephemeral port) | Integer `0`–`65535`. Non-integer or out-of-range values exit with code `2`. |

On startup, the CLI prints `Factory Viewer: http://127.0.0.1:<port>` (or `http://[::1]:<port>` for IPv6). Keep the URL local and do not proxy it to another host; only a literal `127.0.0.1` or `[::1]` `Host` header is accepted (`http://localhost:<port>` and any other non-loopback `Host` header are refused with HTTP `403`). Stop with `Ctrl-C` (`SIGINT` or `SIGTERM`), which closes only the viewer and leaves factories, runs, and Pi sessions untouched.

### Starting and stopping from Pi (`/factory viewer`)

Inside Pi, `/factory viewer` starts the standalone viewer (`factory/viewer/cli.ts`) as a detached child process against the same `defaultFactoryStorePath` used by `/factory list`, forwarding only an explicit environment allowlist (`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TZ`, `PI_CODING_AGENT_DIR`, `PI_BOOTSTRAP_STATE_DIR`, `PI_FACTORY_STATE_DIR`, `PI_FACTORY_COORDINATION_DIR`, `PI_COMS_DIR`, `FACTORY_STATE_PATH`, `FACTORY_VIEWER_PORT`, and `FACTORY_VIEWER_HOST`, with ephemeral port `0` on `127.0.0.1` by default) and stripping `NODE_OPTIONS` and unrelated credentials/secrets. It waits up to 10 seconds for the `Factory Viewer: <url>` startup line, detaches completely so the viewer outlives the Pi session (because `cli.ts` writes nothing to stdout/stderr after the startup URL line, closing the parent pipes after startup is safe), and prints the URL via notification. It does **not** open a browser automatically and never auto-starts when a factory launches or resumes.

- **Node binary resolution (never the compiled `pi` runtime binary):** Before acquiring the lock or writing `factory-viewer.json`, `/factory viewer` resolves a verified Node 26+ binary supporting `--experimental-strip-types` via `resolveNodeBinary` in order: (1) `BOOTSTRAP_NODE` if set (an absolute path or executable name on `PATH`, failing closed with `Invalid BOOTSTRAP_NODE ...` if unusable; `BOOTSTRAP_NODE` is not forwarded into the child's allowlisted environment), (2) `process.execPath` only when its basename is `node` or `nodejs` and it passes verification, and (3) `node` or `nodejs` on `PATH`. If no usable Node binary is found, it fails closed immediately (`Required Node binary ...`) without spawning a process, acquiring a lock, or writing a record. When starting the child, it invokes `<resolved-node> --experimental-strip-types <extensionDir>/factory/viewer/cli.ts`.
- **Startup failure diagnostics:** If the child fails to spawn or exits before printing `Factory Viewer: <url>`, `/factory viewer` reaps it and reports immediately (without waiting the full 10 seconds) with `Failed to spawn Factory Viewer ...` or `Factory Viewer exited before printing URL (code <N> | signal <SIG>; interpreter <path>, entry <cli.ts>)` plus the bounded stderr tail (up to `4096` bytes). If startup reaches the 10-second startup wait, it terminates and reaps the child, removes `factory-viewer.json`, and fails with `Factory Viewer timed out after 10000ms waiting for startup URL (interpreter <path>, entry <cli.ts>)` plus the bounded stderr tail (with no secrets or environment variables).
- **Single-instance runtime record:** The command writes `factory-viewer.json` atomically (mode `0600`, serialized by an exclusive lock) under the Pi agent state root (`PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent/factory-viewer.json`)—separate from `factories.sqlite`, `factory-coordination.sqlite`, and all run/session directories. It writes `state: "starting"` (`version`, `pid`, `boot_id`, `start_time`, `store_path`, `coordination_dir`, `sessions_dir`, `started_at`) **before** waiting for the URL, updates it to `state: "running"` with `port` and `url` once confirmed, and removes the record after reaping the child on startup failure. Record reads require a regular file (`lstat`/`O_NOFOLLOW`, no symlink), owned by the current UID, and not group/world-writable (`mode & 0o022 === 0`).
- **Process verification, store matching, and stale handling:** Before reusing or stopping a recorded PID, the command verifies `pid`, `boot_id`, `start_time`, and on Linux `/proc/<pid>/status` UID and `/proc/<pid>/cmdline` containing the resolved `factory/viewer/cli.ts` entry point (non-Linux platforms without `/proc` fall back to PID/start-time/signal checks). On a `running` verified record, `/factory viewer` compares `store_path`, `coordination_dir`, and `sessions_dir` against the current target: if they differ, it refuses without reusing or killing and prints the running viewer's store and URL (`/factory viewer stop` first); if they match, it probes `GET /api/factories` on loopback (`1500ms` timeout) and reuses if healthy (`200`/`503`) or refuses if unresponsive. If a verified `starting` record remains from an interrupted mid-start parent, the next `/factory viewer` stops that verified orphan and starts cleanly; if the process is gone, identity fails, or the record is corrupt/untrusted, the record is removed without signalling any unverified PID.
- **Status and stop:** `/factory viewer status` reports `starting` or `running` (including the observed store and flagging when it differs from the current target) or plainly reports when no viewer is running. `/factory viewer stop` verifies the recorded process identity, sends `SIGTERM`, escalates to `SIGKILL` after 5 seconds only after re-verifying that PID if it ignores `SIGTERM`, removes `factory-viewer.json`, and reports plainly when no viewer is running. Starting, checking, and stopping never write, migrate, repair, settle, launch, or clean up factory or Bootstrap state, and never require a managing factory session.

---

## 2. Views and navigation

The page shell uses vendored Materialize 1.0.0 CSS markup without Materialize JavaScript:
- **Header and link tabs (`<header>`):** A non-sticky `<nav class="nav-extended blue-grey darken-3" aria-label="Views">` holds the `<h1>` title, `#header-scope`, the mobile drawer trigger (`#menu-toggle`), and `<ul class="tabs tabs-transparent">` containing seven `<a>` link tabs (`Factories`, `Live Graph`, `Inspect`, `Queue`, `Receipts`, `Requests`, `Proposals`) plus `.indicator`. The active tab carries `.active` and `aria-current="page"`; tabs requiring a factory omit `href` and carry `aria-disabled="true"` until a factory is selected. Plain clicks route in-page via `history.pushState`; modified or middle clicks open normally in a new browser tab.
- **Factories sidebar (`<aside id="sidebar" class="sidenav sidenav-fixed">`):** Persistent on desktop (`> 992px` via a `300px` layout offset on `<header>` and `<main>`); on narrow screens (`<= 992px`), a keyboard-accessible modal drawer with `.sidenav-overlay` backdrop (`#drawer-backdrop`), `inert` handling when closed or behind the open drawer, focus trapping, and `Escape` dismissal. Inside, a `<div role="navigation" aria-label="Factories">` landmark (avoiding Materialize's global `<nav>` bar rules) wraps `.collection` lists for active factories, a `"Damaged / uncertain"` section, and a collapsed-by-default `<details class="collapsible">` `"Deleted"` section. Selecting a factory opens **Live Graph** (or **Inspect** for damaged entries). Top view tabs and URL query parameters (`/?factory=<id>&view=<name>`) switch across the seven views:

| View | URL / API route | What it shows |
| --- | --- | --- |
| **Factories** | `?view=factories` · `GET /api/factories` | Returns `{ factories, deleted, damaged }`: active factories (`factory_id`, `name`, `current_version`, `management`), deleted factories (`deleted: true`, `deletion`), and per-row isolated damaged deletion records (`damaged: true`, `evidence: "unavailable"`, `status: "uncertain"`, keeping healthy factories visible). |
| **Live Graph** | `?factory=:id&view=live` · `GET /api/factories/:id/live` | The verified released run's **run graph** drawn from its `bound_version` (never `current_version`), showing nodes, dependency edges (`require_success` / `allow_partial`, derived `pending` / `fired` / `dead`), joins, feedback edges, `current_version` separately from `run`, distinct `outcome` / `settlement` / `capacity_release`, queue `head_status`, and a selected-node detail panel (`current_attempt` and version-bound `View configuration` link). For deleted factories, returns `state: "deleted"` (`run: null`, `graph.absence: "not applicable"`, no `head_status`, never `idle`/`waiting`/`running`) with a `"Deleted"` banner. Supports pointer drag, wheel zoom, keyboard pan/zoom (`+`/`-`/`0`/arrow keys and toolbar buttons), and node selection (`Enter`/`Space`/click). |
| **Inspect** | `?factory=:id&view=inspect[&version=vN&node=id]` · `GET /api/factories/:id/inspect` | Opens with **"What needs my attention?"** (`name`, `management`, `stop_state`, `current_version`, `capacity`, `queue_head`, `attention` linking to Queue/Requests/Proposals; plus a `"Deleted"` banner with deletion time when deleted), followed by `damaged_records`, retained `versions` (with `restored_from` provenance) and a version selector, `runtime_assumptions` / `not_frozen`, `definition.nodes` (labelled fields for `agent` and `command` nodes, policies, dependencies, joins, decisions, feedback targets, `required_checks`, `limits`, with optional policies inside `<details>` accordions), and `operation_evidence`. |
| **Queue** | `?factory=:id&view=queue&filter=open\|all` · `GET /api/factories/:id/queue` | FIFO inputs in acceptance order (`queue_position` ascending), `head_status` blocker explanation (fixed operator explanations, and disposition-specific wording when a non-`queued` head has no active hold), `Open` (default) vs `All` filter, `bound_version` (with `bound_version_evidence: "unavailable"` if damaged), `disposition`, `uncertain`, `accepted_at`, `is_head`, and receipt links (`receipt_url`, `receipt_snapshot_url`). Deleted factories keep all rows readable with a `"Deleted"` banner. |
| **Receipts** | `?factory=:id&view=receipts&reference=...` · `GET /api/factories/:id/receipts?reference=...` | Lookup by submission reference within the selected factory (`404` on unknown or cross-factory reference, never an empty receipt). Explicitly sets `is_run_report: false` (`"Receipt evidence is not a run report."`) and projects admission fields, `bound_version`, `current_version` (or `{ absence: "evidence unavailable" }` without falling back to `bound_version`), `disposition`, and recorded launch `attempt` (plus `deleted` / `deletion` banner when deleted). |
| **Requests** | `?factory=:id&view=requests` · `GET /api/factories/:id/requests` | Direction and exhaustion requests (`request_id`, `kind`, `node_id`, `node_attempt_id`, `state`, bounded/path-scrubbed `question`, `choices`, separate `response_recorded` vs `consumption` / `response_consumed`, `reconciliation`, optional `verdict` / `admissions` / `risk_lane` from recorded snapshots only, `uncertain` / `uncertainty`; plus `deleted` / `deletion` banner when deleted). Exposes no respond or wake controls. |
| **Proposals** | `?factory=:id&view=proposals` · `GET /api/factories/:id/proposals` | Learned-constraint proposals (`is_active_constraints_file: false`, `"Proposals are not the active constraints file."`), `proposal_id`, `reference`, `action` (`add` / `retire`), `source`, `target_constraint_id` / `assigned_constraint_id`, bounded/path-scrubbed `text`, `provenance`, `conflicting_ids`, `outcome`, `file_sync_state`, and `uncertain` / `uncertainty` (plus `deleted` / `deletion` banner when deleted). Exposes no confirm, reject, or conflict-resolution controls. |

**Queue `Open` filter vs `/factory queue --open`:** Viewer `filter=open` keeps unfinished dispositions (`queued`, `blocked`, `retryable`, `launching`, `running`) **and** any uncertain entry—including finished rows whose `bound_version` is damaged and `settled` / `cleared` rows whose attempt record is missing. By contrast, `/factory queue --open` filters only on unfinished disposition, `attempt.uncertainty`, and `run_outcome === "uncertain"`. The viewer errs toward surfacing damaged or incomplete evidence.

---

## 3. State model, typed absence, and version-bound navigation

### Live Graph state set and node statuses

Every `GET /api/factories/:id/live` snapshot carries `factory_id`, `current_version`, `checked_at`, `run` (`{ run_id, attempt_id, bound_version }` or `null`), `state` from a closed six-value active/observed set (`running`, `ended`, `idle`, `waiting`, `blocked`, `uncertain`) plus `deleted` for retired factories, and `reason`:

- **`deleted`** — permanently retired factory (`deleted: true`, `deletion`, `run: null`, `graph: { evidence: "not applicable", absence: "not applicable", explanation }`, no `head_status`); never renders as `idle`, `waiting`, or `running`.

- **`running`** — verified released run with non-terminal nodes; `graph.evidence` is `"available"`, `settlement` is `"unsettled"` (or recorded state), and `capacity_release` is `"held"`.
- **`ended`** — verified run where all nodes reached terminal outcomes (never shown as `"running"` after ending) or a settled/cleared historical run with no active unreleased launch. Settled/cleared historical runs return `graph: { evidence: "not applicable", absence: "not applicable", explanation }`. Every `ended` snapshot also carries `head_status` (and attaches `launch_blocker` when a queued head is blocked).
- **`idle`** — no released run and no active capacity hold (`head_status.blocking_kind` is `"empty"` or `"unmanaged"` with both capacity slots `"free"`).
- **`waiting`** — no released run, and the FIFO head is eligible to launch.
- **`blocked`** — no released run, and a launch attempt is `reserved` / `failed_before_release` (holding capacity without release authorization) or `head_status` / capacity blocks launching. Unreleased launches never render as `"running"` or `"waiting"`.
- **`uncertain`** — missing, damaged, or contradictory release, binding, topology, control, settlement, or capacity evidence (including a damaged bound version while `current_version` is intact, a `settled`/`cleared` attempt without `release_authorized`, or a held `factory_slot` without a current attempt or `factory_held` explanation). Returns `run: null` and `graph: { evidence: "unavailable", absence: "evidence unavailable", explanation }` without falling back to `current_version`.

Every node status renders both a non-color symbol/text label and tone: `Pending` (`pending`), `Waiting` (`waiting`), `Waiting (parked)` (`waiting` + `parked`), `Running` (`running`), `Succeeded` (`succeeded`), `Partial` (`partial`), `Failed` (`failed`), `Blocked` (`blocked`), `Skipped` (`skipped`), `Cancelled` (`cancelled`), and `Uncertain` (`needs_attention`). In review loops, if a node's progress file still reflects an earlier incomplete attempt while a newer attempt is reserved, Live Graph fails closed as `Uncertain` rather than `Blocked`.

### Typed absence vocabulary

Empty or missing evidence distinguishes three machine-readable `absence` values rather than guessing or showing `"No records"`:

- `no records` (`○ No records`) — healthy managed factory with zero matching items (for example, no admitted inputs, no requests, no proposals, or no damaged records).
- `not applicable` (`— Not applicable`) — does not apply in the current state (for example, queue/requests/proposals on an unmanaged factory, settlement on an unauthorized pre-release attempt, or `file_sync_state` on an unconfirmed proposal).
- `evidence unavailable` (`! Evidence unavailable`) — missing, damaged, hot-journal, WAL, or unreadable evidence.

In Inspect, three fields carry explicit documented defaults rather than typed-absence wrappers: `queue_head` omits undefined top-level `input_id`, `reference`, and `bound_version` while `queue_head.input` carries the typed absence; `definition.limits.max_total_attempts_source` defaults to `"built-in"` when unset; and `definition.restored_from` falls back to `"not applicable"` when the inspected version is absent from `versions`.

### Version-bound navigation

- **Live Graph to Inspect:** Each node's `configuration_link` (`View configuration`) carries `(factory_id, version, node_id)` in the run's `bound_version`, even after newer definitions are published.
- **Inspect version selector:** Passing `?version=vN` updates `inspected_version`, `versions[*].inspected`, and `definition` only; `current_version`, `current_definition`, `attention_summary`, `capacity`, `queue_head`, `attention`, and `operation_evidence` remain current. If `vN` is damaged or not retained, `definition` reports `evidence: "unavailable"` and `absence: "evidence unavailable"` without falling back to `current_version`.
- **Inspect node links:** `dependencies.items`, `join.sources`, `policies.join.sources`, `decision` (`feedback_target_link`, `loop_body_links`), `feedback_target`, and `relationships` emit version-bound links within `inspected_version`. Unverifiable targets emit `{ absence: "evidence unavailable", explanation }` instead of links. Passing `?node=...` (and optional `?factory=...`) resolves `target_node` in `inspected_version` (`verified: true` with `node`, or `verified: false` with `absence: "evidence unavailable"` when unknown, mismatched, unretained, or damaged—never redirecting to another version).

---

## 4. Loading, timeout, live polling, and Stale vs Uncertain vs Reconciliation

### Loading states and 15-second request timeout

Initial factory-list and view loads display an explicit loading indicator (`Loading factories...` / `Loading <View>…` with `aria-busy="true"`), never pre-populating `"No records"`. Client `fetchJsonStrict` calls enforce a 15-second timeout (`FETCH_TIMEOUT_MS = 15000` via `AbortController`), surfacing `"Request timed out"` on expiry. Switching factories or views aborts in-flight requests and discards stale or `factory_id`-mismatched responses.

### Polling and in-place Live Graph updates

- While **Live Graph** is active for a selected factory and the page is visible (`!document.hidden`), the client polls `/api/factories/:id/live` roughly every 2 seconds (`LIVE_POLL_INTERVAL_MS = 2000`), including while `idle`, `waiting`, `blocked`, `ended`, or `uncertain`.
- Ticks are skipped while a request is in flight (never overlapping), polling pauses when `document.hidden` is true, and returning to visibility triggers an immediate refresh.
- The other six views (**Factories**, **Inspect**, **Queue**, **Receipts**, **Requests**, **Proposals**) refresh only on user navigation or action (no background polling).
- When a poll returns the same `(run_id, attempt_id, bound_version)`, the client patches SVG nodes/edges, banners, facts, and the selected-node detail panel in place—preserving `viewBox` pan/zoom, selected node, expanded `<details>` accordions, and keyboard focus while keeping the `aria-live="polite"` announcer restricted to meaningful state, stale, or run transitions.
- When a different verified run starts, the graph rebuilds and resets pan/zoom and selection. An `ended` run's final outcome, settlement, capacity release, and `head_status` / `launch_blocker` stay visible until a new verified run starts, uncertainty is reported, or the factory changes, and an ended run is never presented as active.

### Distinguishing `Stale`, `Uncertain`, and `reconciliation`

These three terms describe different layers and are rendered distinctly:

1. **`⟳ Stale` (client-side refresh failure overlay):** When a Live Graph refresh fails (network error, 15-second timeout, non-404 HTTP error, invalid JSON, or `factory_id` mismatch) while a good snapshot already exists for the selected factory, the client retains that last good snapshot under a double-bordered `⟳ Stale` banner showing the last successful `checked_at` timestamp and failure reason. The next valid snapshot clears `Stale`. An HTTP `404` clears the snapshot into an error banner rather than `Stale`, and switching factories immediately discards the previous factory's snapshot and any `Stale` overlay.
2. **`? Uncertain` (server-side snapshot state):** Returned in a fresh valid snapshot when `state === "uncertain"` or `evidence === "unavailable"`. It replaces the last good snapshot and renders `? Uncertain` (dashed warning) without `Stale`, distinguishing a storage/evidence problem from a transport/refresh failure.
3. **`reconciliation` (read-only Request observation):** In **Requests**, each record carries `reconciliation` (`"pending" | "continuing" | "resolved" | "cancelled" | "failed" | "uncertain"`), projecting the observed status of a direction or exhaustion request and its response delivery/routing. It is strictly a read-only observation field, distinct from both client `Stale` state and disk-mutating store reconciliation (which the viewer never performs).

---

## 5. Read-only guarantees, privacy, and HTTP/asset contract

### Local assets and strict CSP

The browser requests only exact-match local routes in `STATIC_ASSETS`:

- `GET /` or `/index.html` — HTML shell (skip link, `<header>`, `<aside id="sidebar">` with `<div role="navigation" aria-label="Factories">` landmark, `<main id="main-content">`, single `<h1>`, drawer controls, seven-view `<nav>` link tabs; allows query params).
- `GET /vendor/materialize/materialize.min.css` — vendored `materialize-css@1.0.0` (MIT) CSS-only build with remote URL comments stripped; no Materialize JS, Material Icons font, or Google Fonts / webfonts (tabs, drawer, and `<details>` accordions use local accessible vanilla JS and CSS).
- `GET /style.css` — minimal local CSS overrides layered over Materialize's own system font stack (zero `--fv-*` tokens or font-family overrides), bounded to ten explicit categories: (1) Run graph SVG using Materialize palette hex values, (2) `:focus-visible` outlines, (3) `.skip-link` / `.sr-only`, (4) `prefers-reduced-motion: reduce`, (5) drawer open/closed state, overlay, and `300px` offset, (6) `<details>` `.collapsible` open body and marker, (7) `.table-wrap` scroll wrapper (and `white-space: nowrap` on table `.chip`s), (8) dashboard `h1`–`h4` sizes, (9) wrapping for long identifiers (`code`, `.mono`, `#content .btn` / `.btn-flat`, `.collection-item`, `dd`), and (10) content-link underlines and contrast fixes.
- `GET /safe.js` — pure client validation, `safeHref`, typed-absence, label-mapping, live-poll scheduling, run-transition/stale state-machine, and keyed diff helpers.
- `GET /app.js` — vanilla JS client (`textContent`, `createTextNode`, allowlisted HTML/SVG attributes, zero `innerHTML` or `eval`, centralized `TONE_PALETTE_CLASSES` mapping, accessible drawer with focus trapping and `inert`, in-place SVG patching, `<details>` accordions).

Non-page static assets reject query strings (`404`), dot-segment traversal returns `404`, and all static responses send `cache-control: no-store`, `x-content-type-options: nosniff`, and:

```text
content-security-policy: default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

### HTTP snapshot API contract

The API is **GET-only** (`405` with `Allow: GET` for any other method) and **identifier-only** (never accepts filesystem paths; query values > 256 chars, duplicate keys, or unknown keys return `400`). Bad request targets or malformed URLs return `400`; any `Host` header other than literal `127.0.0.1` or `[::1]` (including `localhost`) returns `403`; unknown routes return `404`.

| Endpoint | Allowed query parameters | Error / unavailable behavior |
| --- | --- | --- |
| `GET /api/factories` | None (`400` if any) | `200` `{ factories, deleted, damaged }` (isolating damaged deletion records per row into `damaged` while keeping healthy factories visible; `{ factories: [], deleted: [], damaged: [] }` if store file does not exist yet); `503` `{ error: "Evidence unavailable" }` on damaged/hot-journal/WAL store. |
| `GET /api/factories/:id/live` | None (`400` if any) | `404` unknown factory; `503` on failing store/coordination read or damaged deletion record; `200` `state: "deleted"` for deleted factories; `200` `state: "uncertain"` on contradictory/damaged run or release evidence. |
| `GET /api/factories/:id/inspect` | Optional `version` (`v1`, `v2`, …), `node`, `factory` (`[A-Za-z0-9_-]{1,128}`) | `400` malformed/extra/duplicate param; `404` unknown factory; `200` `{ evidence: "unavailable", absence: "evidence unavailable" }` on damaged/hot-journal/WAL store. |
| `GET /api/factories/:id/queue` | Optional `filter=open\|all` (default `open`) | `400` invalid/extra/duplicate param; `404` unknown factory; `200` `{ evidence: "unavailable", entries: [], absence: "evidence unavailable" }` on damaged/hot-journal/WAL store. |
| `GET /api/factories/:id/receipts` | Required `reference` (<= 256 UTF-8 bytes, no whitespace/control chars) | `400` missing/malformed/extra/duplicate param; `404` unknown factory or unknown/cross-factory reference; `503` on damaged/hot-journal/WAL store. |
| `GET /api/factories/:id/requests` | None (`400` if any) | `404` unknown factory; `200` `{ evidence: "unavailable", records: [], absence: "evidence unavailable" }` on damaged/hot-journal/WAL store or missing `factory_managers` on empty established factory. |
| `GET /api/factories/:id/proposals` | None (`400` if any) | `404` unknown factory; `200` `{ is_active_constraints_file: false, evidence: "unavailable", records: [], absence: "evidence unavailable" }` on damaged/pre-v12/hot-journal/WAL store. |

### Read-only enforcement and projection privacy

- **Zero write/recovery paths:** The viewer never creates files, migrates schema (e.g. a v12 store stays at v12), recovers hot journals or WAL sidecars, reconciles runs on disk, settles holds, launches runs, or cleans up tabs. Live Graph passes only passive preflight and raw non-release verifiers (`prepareDefinition`, `prepareFromDefinition`, `validateFactoryNonReleaseEvidence`, `validateFactoryPreReleaseAbortAndExit`, plus viewer-owned `directionObservation`, `directionRouting`, `directionExhaustions`), never standalone `status`, `statusWithCleanup`, or `settlementObservations`.
- **Non-blocking regular-file checks:** Viewer-owned JSON readers, handoff pre-checks, and direction readers verify paths with `O_NONBLOCK | O_NOFOLLOW` and `fstat` regular-file checks (pre-checking both edge claim and join claim source-attempt result paths before `describeHandoff`). Risk-lane scope in Requests uses `liveIfNoAfterSnapshot: false` (never walking the live working tree).
- **Allowlisted projections & path scrubbing:** Responses exclude raw prompts, full input briefs, logs, internal records, `canonical_checkout`, raw `sync_error`, responder/decider identities, and action flags (`can_respond`, `can_redeliver`, `can_confirm`, etc.). `sanitizeOperatorText` normalizes whitespace, replaces control/bidi/zero-width characters with `[ctrl]`, truncates by Unicode code points without splitting surrogate pairs, redacts store/coordination/index/checkout/session/home paths, and conservatively scrubs generic absolute path-like tokens (`/..`, `~/..`, `file://..`, drive letters) to `[redacted-path]`.

---

## 6. Known limits

- **Residual TOCTOU window in handoff reads:** A time-of-check/time-of-use gap remains between the viewer's `O_NONBLOCK | O_NOFOLLOW` + `fstat` pre-check and `describeHandoff`'s path-based read in `bootstrap/handoff.ts`. Swapping a regular handoff file for a FIFO in that window requires local write access to the session directory and is outside the viewer's threat model.
- **Direct unknown-factory guard on Requests:** `GET /api/factories/:id/requests` verifies `factory_id` against `op({ action: "identities" })` directly in `server.ts` to return HTTP `404`, because `/factory requests` in `factory/operations.ts` (~line 4342) currently throws a `ReferenceError` on an unknown ID (`missing` is referenced before its `const` declaration at ~line 6665—a pre-existing defect left untouched).
- **Conservative generic path scrubbing:** Operator text containing genuine path-like tokens (starting with `/`, `~`, `file://`, or a drive letter) is redacted to `[redacted-path]`.
- **No historical run graph browser or action controls:** Live Graph shows only the active or most recent observed run; all factory actions stay in Pi.

---

## 7. Verification and manual acceptance checklist

### Automated verification

The automated viewer suite exercises the HTTP snapshot API, static asset allowlist/CSP/DOM-sink hygiene, `safe.js` logic in `node:vm`, read-only byte-for-byte state preservation (`verifyReadOnlyViewer`), sentinel leak scans, `SIGKILL` FIFO watchdogs (`verifyReadOnlyViewerInChild`), and the Materialize component/CSS guard (`bootstrap/factory-web-viewer-materialize-guard.test.ts`) against isolated temporary fixtures:

- **Materialize guard:** Verifies every class in `index.html` and emitted by `app.js` (static, composed, and DOM-rendered across all seven views) exists in `materialize.min.css` or `PERMANENT_CLASS_ALLOWLIST`, every selector in `style.css` is in `PERMANENT_STYLE_SELECTORS_BY_CATEGORY` (the ten custom CSS categories above) with no dead selectors, `--fv-*` tokens, font overrides, `@charset`, or `@font-face` rules, and every `.chip` and `.card-panel` across all seven views carries one of the six `TONE_PALETTE_CLASSES` sets. The temporary migration allowlists (`TEMPORARY_LEGACY_CLASS_ALLOWLIST` and `TEMPORARY_LEGACY_STYLE_SELECTORS`) are now empty (`size === 0`). Negative controls verify that invented classes, invented selectors, `@charset`, `@font-face`, and nested rules fail.

```sh
node --test --experimental-strip-types --test-force-exit --test-timeout=60000 bootstrap/factory-web-viewer*.test.ts
```

Run docs consistency checks with:

```sh
node --test --experimental-strip-types --test-force-exit --test-timeout=60000 bootstrap/docs.test.ts
```

### Manual acceptance checklist (not automated)

Browser DOM rendering, pan/zoom/focus survival, keyboard-only navigation, drawer modal behavior, visual focus cues, and runtime network requests are verified manually against isolated temporary fixtures (never against `~/.pi/agent` or a real factory).

**Execution status:**
- **Ticket 09 builder:** ran Scenarios 1, 3, and 5 (plus local-only network inspection and byte-for-byte unchanged fixture verification) against its own isolated fixture in headless Chrome via CDP.
- **Ticket 10 reviewer (2026-11-24):** ran Scenario 1 (Pass, by keyboard) and Scenario 3 (Pass, by CDP request interception) against the round-1 version of `factory-viewer-manual-fixture.ts`.
- **Ticket 10 round-1 fix builder verification (not a reviewer run; 2026-11-24, Google Chrome `158.0.8127.88` headless via CDP against `node bootstrap/test-support/factory-viewer-manual-fixture.ts`):**
  - **Scenario 1:** Pass — observed 4-node `v2` graph (`left`, `right`, `review`, `merge`) with `v2` bound version separate from `v3` current version; `View configuration` on `merge` and Inspect links (`right`, `review`, and `review` -> `left`) stayed in `v2`.
  - **Scenario 3:** Pass — `kill -STOP <pid>` triggered `⟳ Stale` after the 15-second timeout (`Request timed out`, preserving `checked_at` and the 4-node graph); `kill -CONT <pid>` cleared `⟳ Stale`; `gamma-uncertain` rendered `? Uncertain` with 0 graph nodes and no `Stale`; switching from `Stale` `alpha` to `delta-unmanaged` immediately discarded `alpha`'s graph and `Stale` overlay and loaded `delta` as `⊘ Blocked`.
  - **Scenario 5 (scripted inside timer window):** Pass (with `--advance-live-ms 5000`; round 2 adds the operator `SIGUSR1`/TTY `Enter` trigger so the timer never races a human operator) — `viewBox` pan/zoom, selected node `right`, expanded `Optional attempt timestamps` `<details>`, and keyboard focus on `<summary>` were preserved in place while `right` transitioned from `● Running` to `✓ Succeeded` and gained `Completed at`.
  - **Local-only network audit:** Pass — 0 external requests across all navigated views.
- **Ticket 10 round-2 fix builder verification (2026-11-25, Google Chrome `158.0.8127.88` headless via CDP against `node bootstrap/test-support/factory-viewer-manual-fixture.ts` without `--advance-live-ms`):**
  - **Scenario 1:** Pass — 4-node `v2` graph (`left`, `right`, `review`, `merge`) with `v2` bound separate from `v3` current; `View configuration` on `merge` and Inspect links (`right`, `review`, `left`) stayed in `v2`.
  - **Scenario 5 (operator trigger after 20 s wait):** Pass — after panning/zooming (`viewBox`), selecting `right`, expanding `Optional attempt timestamps`, and focusing `<summary>`, deliberately waited 20 s (confirming `right` stayed `● Running`), then sent `kill -USR1 <pid>` and observed `right` transition in place to `✓ Succeeded` with `Completed at` while preserving `viewBox`, selection, open `<details>`, and `<summary>` focus.
  - **Scenario 3:** Pass — `kill -STOP <pid>` triggered `⟳ Stale` after ~17 s (`Request timed out`, 4 nodes preserved); `kill -CONT <pid>` cleared `Stale`; `gamma-uncertain` showed `? Uncertain` with 0 nodes and no `Stale`; switching from `Stale` `alpha` to `delta-unmanaged` immediately discarded `alpha`'s graph and `Stale` overlay and loaded `delta-unmanaged` as `⊘ Blocked` after `kill -CONT`.
  - **Local-only network audit:** Pass — 43 requests total, 0 external requests; Chrome's automatic `GET /favicon.ico` hit the local loopback viewer and returned `404`.
- **Materialize slice 3 builder verification (2026-11-25, Google Chrome `158.0.8127.88` headless via CDP with `--disable-extensions` against `node bootstrap/test-support/factory-viewer-manual-fixture.ts`):**
  - **All seven views at `1280px` and `390px`:** Pass — zero horizontal page scroll (`scrollWidth <= innerWidth` across all 14 view/viewport checks), zero clipped `.chip`, `#content .btn` / `.btn-flat`, or `ul.collection a` elements, and zero text contrast failures (minimum rendered text contrast across 35–154 visible text nodes per view/viewport: `5.46:1`, >= `4.5:1`).
  - **Console CSP & external network audit:** Pass — 160 local requests total, 0 external requests, 0 console errors, 0 CSP violations.
  - **Scenario 1:** Pass — 4-node `v2` graph (`left`, `right`, `review`, `merge`) with `v2 (differs from current v3)`, `View configuration` on `merge`, and Inspect links stayed in `v2`.
  - **Scenario 5:** Pass — `+` zoom changed `viewBox` (`102 37 813 298`), `right` selected via `Enter`, `Optional attempt timestamps` `<details>` expanded with focus on `<summary>`; after `kill -USR1 <pid>` and poll, `right` transitioned to `✓ Succeeded` with `Completed at` while `viewBox`, selection, `<details>.open`, and `<summary>` focus survived.
  - **Reduced motion (`prefers-reduced-motion: reduce`):** Pass — computed `transitionDuration` and `animationDuration` were `0s`.
  - **Drawer & focus outline CDP checks (`390px` / `1280px`):** Pass — closed `#sidebar` at `390px` starts `inert`, opens via `#menu-toggle` moving focus inside, and `Escape` closes it, restores `inert`, and returns focus to `#menu-toggle`; desktop `#content .btn` shows a `3px solid` focus outline, single `<h1>`, and `<th scope="col|row">` headers.
  - **NOT YET RUN after Materialize migration:** Scenario 3 (`kill -STOP` / `kill -CONT` stale overlay) re-run, full human keyboard-only traversal of every control, real-device / screen-reader checks, and manual fixture read-only byte-for-byte check without Scenario 5 trigger (covered only in automated tests).
- **Scenarios 2 and 4, and real-device / screen-reader checks, have NOT YET RUN in a browser** (Scenario 2 was checked through the HTTP API only in automated tests; Slice 3 CDP scripts probed Scenario 2 views and Scenario 4 drawer/outline programmatically, which does not substitute for full human/screen-reader acceptance) and must be executed manually before sign-off.

**Launch an isolated temporary fixture for manual review:**

```sh
node bootstrap/test-support/factory-viewer-manual-fixture.ts
```

This helper isolates `HOME`, `PI_FACTORY_COORDINATION_DIR`, `PI_BOOTSTRAP_STATE_DIR`, `statePath`, and `coordinationPath` inside a fresh temporary directory under `$TMPDIR` (resolving relative `TMPDIR` values to an absolute path and never touching `~/.pi/agent`), prints the loopback URL, viewer `PID`, scenario links, and the `kill -USR1 <pid>` trigger command, and deletes the temporary directory on `SIGINT`/`SIGTERM`/`SIGHUP` (including signals arriving during fixture build) or startup failure. Note: `delta-unmanaged` shares `alpha`'s held checkout, so it renders `blocked` (`The factory is unmanaged and the target checkout slot is held by another factory or run.`), and no fixture factory shows `idle`.

If running `node factory/viewer/cli.ts` directly against a fixture instead of the helper, set `FACTORY_STATE_PATH`, `PI_FACTORY_COORDINATION_DIR`, `PI_BOOTSTRAP_STATE_DIR`, and `HOME` to temporary directories (see Section 1).

For Scenario 5, human operators should run the helper **without** `--advance-live-ms` and trigger node `right`'s completion when ready via `kill -USR1 <pid>` (or pressing `Enter` in the helper's TTY terminal). Optional `--advance-live-ms <ms>` (accepted range `1`–`2147483647`, i.e., `2^31 - 1`) is for scripted runs only and counts from when the helper prints its URLs (not from when the browser opens the page). Because triggering Scenario 5 (or passing `--advance-live-ms`) writes node `right`'s completion file into the fixture's session directory, run the "Read-only store preservation" cross-cutting check without triggering Scenario 5 or passing `--advance-live-ms`.

#### Scenario 1 — Older bound version (verified 2026-11-25 in headless Chrome via CDP)
- **Fixture:** `alpha-live-v2` (`v2` 4-node graph with join + feedback loop currently running; `v3` `only_v3` published as `current_version`).
- **Steps:**
  1. Open the printed URL for `alpha-live-v2` (`/?factory=<alpha>&view=live`).
  2. Observe the run identity and current version facts, then select node `merge` and activate **View configuration**.
  3. In **Inspect**, follow `merge`'s join/dependency links (`review`, `right`), and from `review` follow its dependency/feedback target link (`left`).
- **Expected result:** Live Graph draws the 4-node `v2` topology (`left`, `right`, `review`, `merge`), displays `v2` as bound version separately from `v3` as current version, and `View configuration` + Inspect node links resolve inside `v2` without redirecting to `v3`.
- **Status:** `[x] Pass (2026-11-25, headless Chrome 158.0.8127.88 via CDP)` `[ ] Fail`

#### Scenario 2 — Release evidence (NOT YET RUN in a browser)
- **Fixture:** `beta-unreleased` (`reserved` launch attempt holding capacity without release) and `gamma-uncertain` (`released` attempt with missing/contradictory `release.json`).
- **Steps:**
  1. Open `/?factory=<beta>&view=live`.
  2. Open `/?factory=<gamma>&view=live`.
  3. Open `/?factory=<epsilon>&view=inspect&version=v2` (damaged `v2` while `v4` is current) and `/?factory=<epsilon>&view=queue&filter=open`.
- **Expected result:** `beta-unreleased` shows state `⊘ Blocked` with an explanation and draws no running graph; `gamma-uncertain` shows `? Uncertain` with an explanation and draws no running graph; `epsilon-versions` `v2` in Inspect reports `evidence unavailable` without falling back to `v4`, and Queue `Open` retains the finished `v2`-bound row flagged with damaged version.
- **Status:** `[ ] Pass` `[ ] Fail` (NOT YET RUN in browser; HTTP API verified in automated tests)

#### Scenario 3 — Connection failure, Stale vs Uncertain, and factory switch (verified 2026-11-25 in headless Chrome via CDP)
- **Fixture:** `alpha-live-v2`, `gamma-uncertain`, and `delta-unmanaged` (which renders `blocked`, not `idle`) from `node bootstrap/test-support/factory-viewer-manual-fixture.ts` (note the printed `PID: <pid>`).
- **Steps:**
  1. Open `alpha-live-v2` Live Graph and wait for at least one successful snapshot.
  2. Pause the viewer process with `kill -STOP <pid>` and wait >17s (15-second client request timeout plus a 2-second poll tick) — or, in Browser DevTools Network tab, enable **Block request URL** on `/api/factories/*/live` and wait >2s.
  3. Resume the viewer with `kill -CONT <pid>` (or unblock the URL in DevTools) and wait >2s for recovery.
  4. Switch to `gamma-uncertain`. Then return to `alpha-live-v2`, trigger `⟳ Stale` again with `kill -STOP <pid>` (or DevTools URL block), and immediately click `delta-unmanaged` in the sidebar while `alpha` is `Stale` (then run `kill -CONT <pid>` if stopped so `delta-unmanaged` can load).
- **Expected result:** Step 2 keeps `alpha`'s last good graph overlaid with the double-bordered `⟳ Stale` banner showing the last `checked_at` timestamp and failure reason (`Request timed out` when stopped); step 3 clears `⟳ Stale`; `gamma-uncertain` replaces any snapshot with dashed `? Uncertain` (never `⟳ Stale`); switching from `Stale` `alpha` to `delta-unmanaged` immediately discards `alpha`'s graph and `Stale` overlay and loads `delta-unmanaged` as `⊘ Blocked`.
- **Status:** `[x] Pass (2026-11-25, headless Chrome 158.0.8127.88 via CDP)` `[ ] Fail`

#### Scenario 4 — Accessibility, keyboard-only use, and narrow drawer layout (NOT YET RUN in a browser; real-device / screen-reader NOT YET RUN)
- **Fixture:** All five factories from `factory-viewer-manual-fixture.ts`.
- **Steps:**
  1. Resize the browser to narrow width (`<= 992px`), open the **Factories** drawer via keyboard (`Enter`/`Space` on the menu button), `Tab` inside the drawer, press `Escape`, and confirm focus returns to the toggle button.
  2. Resize back to desktop (`> 992px`) and navigate strictly by keyboard (`Tab`, `Shift+Tab`, `Enter`, `Space`, arrow keys) through all seven views, the Inspect version selector (`epsilon-versions` `v3` restored from `v1`), Inspect node links (`?node=...`), Queue `Open`/`All`, Receipt lookup (`ref-alpha-v1`), Requests, and Proposals.
  3. Inspect headings (`h1`/`h2`/`h3`/`h4`), table headers (`<th scope="col|row">`), status pills, and visible focus outlines; optionally run a real-device and screen-reader pass.
- **Expected result:** Every interactive control is reachable by keyboard with a clear focus outline; drawer traps focus when open and closes on `Escape`; node links scroll to and focus the target card; every status has a text/symbol cue independent of color; real-device/screen-reader behavior is verified.
- **Status:** `[ ] Pass` `[ ] Fail` (NOT YET RUN in browser / screen reader)

#### Scenario 5 — Live refresh continuity (verified 2026-11-25 in headless Chrome via CDP)
- **Fixture:** `node bootstrap/test-support/factory-viewer-manual-fixture.ts` (starts with `left` as `◷ Waiting (parked)` and `right` as `● Running` with `Started at`/`Updated at` timestamps, and waits for an operator trigger to write `right`'s completion result while keeping `run_id`, `attempt_id`, and `bound_version` unchanged; scripted runs may pass `--advance-live-ms <ms>`, which counts from helper launch rather than page open).
- **Steps:**
  1. Open `alpha-live-v2` Live Graph, pan/zoom the SVG (`+` / arrow keys or wheel/drag), select node `right` (`Enter`/`Space`), expand `Optional attempt timestamps` (`<details>`), and leave keyboard focus on a control or node (for example the `<details>` `<summary>`).
  2. When you are ready, run `kill -USR1 <pid>` using the `PID` printed at startup (or press `Enter` in the helper's TTY terminal), then wait >2 seconds for the next poll so `right` transitions from `● Running` to `✓ Succeeded` (adding `Completed at` inside `Optional attempt timestamps`).
- **Expected result:** Pan/zoom (`viewBox`), selected node `right`, expanded `<details>` timestamps, and keyboard focus are preserved while node `right` updates to `✓ Succeeded` in place. Ended-to-next-run graph rebuild and selection/pan-zoom reset (when a new `run_id` / `attempt_id` starts) are verified in the automated suite (`classifyLiveTransition` in `bootstrap/factory-web-viewer-assets.test.ts` and `bootstrap/factory-web-viewer-live.test.ts`).
- **Status:** `[x] Pass (2026-11-25, headless Chrome 158.0.8127.88 via CDP)` `[ ] Fail`

#### Cross-cutting manual checks
- **No external requests:** Open Browser DevTools Network tab on initial load and across all seven views; confirm only local loopback requests (`/`, `/vendor/materialize/materialize.min.css`, `/style.css`, `/safe.js`, `/app.js`, `/api/...`, plus Chrome's automatic local `/favicon.ico` request which returns `404` from the viewer) and zero external CDN, Google Fonts, or Material Icons requests (`[x] Pass` `[ ] Fail`).
- **Keyboard-only use & focus preservation:** Complete navigation across views, graph pan/zoom/node selection, Inspect node links, and drawer open/Escape without using a mouse, confirming focus is visible and never jumps unexpectedly on refresh (`[ ] Pass` `[ ] Fail`).
- **Read-only store preservation (manager closed):** Confirm no mutating action controls exist in any view and running the viewer against an isolated fixture without triggering Scenario 5 (`kill -USR1`, TTY `Enter`, or `--advance-live-ms`) leaves every file in the fixture directory byte-for-byte unchanged (`[ ] Pass` `[ ] Fail`).
