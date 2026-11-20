# Launching the first input safely (ticket 03)

## Command and authority surface

- `/factory launch <factory-id>` (interactive managing Pi session with UI only; blocked in Bootstrap worker sessions, non-UI modes, and untrusted projects): takes the oldest eligible input at the head of the factory's FIFO queue and launches one Bootstrap run into the managing pane's Herdr workspace (`HERDR_ENV=1`, `HERDR_PANE_ID` via `herdr pane get`, never the focused workspace).
- No model tool, chat message, startup hook, `/factory resume`, `/factory submit`, `/factory inspect`, `/factory receipt`, or background timer launches a run. `factory_inspect` remains read-only (`list`, `inspect`, `receipt`).
- **Retained executable definition:** Launch consumes only the integrity-verified retained `v1` definition bound at admission (target checkout, topology, nodes, contracts, dependencies, ownership, persona system prompts, resolved model/thinking, declared tools/skills/extensions, limits). Changes to `.pi/agents/*.md`, `modelAliases`, or `graph.defaults` after admission do not alter queued inputs. Live prerequisites (`project_cwd`, writable `.pi/agent-sessions`, `coms_extension`, retained extension paths, `worker.ts`, `pi` and `herdr` on `PATH`, `required_artifact_paths` publication checks, and live `graph.ceilings` in `bootstrap.json`) are checked at launch and fail closed, blocking the FIFO head without skipping or substituting.
- **Project trust and session incarnation fencing:** Both live session authority (`session_shutdown`, session ID/file binding, `factory_managers`) and project trust (`ctx.isProjectTrusted()` plus `trust.json` / target checkout verification) are checked at launch start, before reservation commit, and synchronously right before release authorization with zero `await` gap between the final fence, the SQLite release commit, and `release.json` publication.
- **Immutable task input and bounded brief:** The accepted brief is preserved verbatim (including multiline CRLF/CR/LF, tabs, leading/trailing spaces/newlines, control characters, unicode, and up to 16 KiB UTF-8) in `${session_dir}/${instance}.input.json` (protected by `input_hash`, retrievable via `bootstrap_read_input({ kind: "task_input" })`). Worker prompts embed only a bounded excerpt (`BRIEF_FIELD_MAX_BYTES = 2048`) plus pointer and treat the brief strictly as literal untrusted input, never as plan data or paths.

## Cross-storage ordering, coordination, and release gate

1. **Pre-launch checks & Herdr workspace lookup:** Live preflight, authority/trust, and `herdr pane get <HERDR_PANE_ID>` run before any capacity hold is committed.
2. **Atomic multi-DB reservation (`factories.sqlite` + `factory-coordination.sqlite`):**
   - `factories.sqlite` lives in `PI_FACTORY_STATE_DIR` (or `PI_BOOTSTRAP_STATE_DIR`, defaulting to `~/.pi/agent/bootstrap-sessions`).
   - Host-wide checkout coordination lives in `factory-coordination.sqlite` in `~/.pi/agent` (OS account home via `BootstrapService`'s `home` option, independent of `PI_CODING_AGENT_DIR` profiles, `PI_FACTORY_STATE_DIR`, and `PI_BOOTSTRAP_STATE_DIR`), with `PI_FACTORY_COORDINATION_DIR` accepted only for explicit test isolation.
   - A companion continuity anchor (`factory-coordination.sqlite.anchor.json` paired with `coord_meta` inside the DB) prevents treating a missing or replaced previously initialized central coordination DB as a clean slate across state roots.
   - Both databases use SQLite `DELETE` journal mode, `synchronous = EXTRA`, symlink-free physical paths (`lstat` across all path components), and fsynced directory ancestry.
   - Inside a single `BEGIN IMMEDIATE` transaction attaching `factory-coordination.sqlite` as `coord` (using SQLite's rollback super-journal protocol across both DBs), the launcher verifies schema/continuity/manager/queue/hold integrity and checks both the factory slot (`factory_holds`) and checkout-scoped central evidence (`coord.checkout_holds` and `coord.managed_runs` by `canonical_checkout`, failing closed across factories on orphaned/contradictory records while keeping independent checkouts isolated), then atomically commits:
     - `factory_inputs.disposition = "launching"`
     - `factory_attempts` (`attempt_id`, `request_id`, `task_id`, `canonical_checkout`, `state = "reserved"`, `release_authorized = 0`, SHA-256 `record_digest`)
     - `factory_holds` (factory slot hold)
     - `coord.checkout_holds` (host-wide canonical checkout hold)
     - `coord.managed_runs` (`task_id` and `request_id_digest` association)
3. **Synced Bootstrap run preparation:** `ensureSessionDir(..., durable=true)` syncs `.pi`, `.pi/agent-sessions`, and `sessionDir` directory entries. `manifest.json`, `index/${task_id}.json`, `factory-run.json`, `index/factory-runs/${task_id}.json`, `request-${requestKey}.json`, `upstream-index.json`, `${instance}.input.json`, `${instance}.config.json`, and `${instance}.sh` are written via `open("wx")` + `fsync` + `rename`/`link` + parent directory `fsync`.
4. **Herdr launch & readiness wait:** Tabs/panes are created in the managing pane's workspace and workers acknowledge readiness while blocked at the release barrier.
5. **Affirmative release authorization before worker action:**
   - After readiness checks pass, the launcher synchronously verifies session authority, project trust, and full identity/run/hold/`coord.managed_runs` agreement (matching what workers check), then commits `release_authorized = 1`, `release_token_digest = sha256(manifest.token)`, `state = "released"`, and `factory_inputs.disposition = "running"` across `factories.sqlite` and `coord` in one `BEGIN IMMEDIATE ... COMMIT` super-journal transaction.
   - Immediately (with no `await` gap), `release.json` is written and fsynced (with its parent directory synced).
   - `bootstrap/worker.ts` refuses to pass the release barrier unless both `release.json` AND `factories.sqlite` + `factory-coordination.sqlite` (`PRAGMA query_only = ON`) prove `release_authorized = 1`, matching `release_token_digest`, matching `factory_holds`, `coord.checkout_holds`, `coord.managed_runs`, and `factory-run.json`.
   - Read-only inspection validates `release.json` contents (JSON validity, token/digest, and `factory_managed` identity) without repairing or deleting invalid markers.

## Read-only inspection and direct run mutation guards

- `/factory inspect`, `/factory receipt`, `factory_inspect`, `BootstrapService.status`, `statusWithCleanup`, `waitForStatus`, `recover({ action: "inspect" })`, `SessionStore.list`, and graph widgets are strictly read-only for factory-managed runs: no launch repair, no `reconcile(..., persist=true)`, no status-triggered `disposition.json` writes, no automatic cleanup, and no timeout-triggered cancellation.
- Direct `bootstrap_generate` replay of a factory `request_id`, `bootstrap_cancel`, `bootstrap_cleanup` (including `delete_session_files`), `bootstrap_recover` (`retry_delivery`), and `bootstrap_report` reject on factory-managed runs — including across alternate `PI_BOOTSTRAP_STATE_DIR` roots and when ancillary metadata (`factory-run.json`, `factory_managed`) is missing, stripped, or corrupted.
- Capacity holds are conservative across uncertainty and settlement in this slice (no auto-clear, retry/replay, takeover, or autonomous progression). Missing or contradictory evidence is surfaced in `inspect` (`capacity.* = "uncertain"`, `uncertainty` reasons) without exposing authority secrets.

## Durability boundary and limitations

- All SQLite commits use `DELETE` + `synchronous = EXTRA` + `ATTACH` super-journal transactions over symlink-rejected physical paths with fsynced directory ancestry, and Bootstrap launch/release files and directories are explicitly `fsync`ed.
- On Linux local filesystems (`ext4`, `xfs`, etc.) with barrier/flush support enabled, this provides atomic crash recovery across process termination (`SIGKILL`), Herdr loss, ordinary reboot, and OS crash when local storage is intact and not rolled back.
- **Testing limitation:** Supervised `SIGKILL` tests verify SQLite rollback, super-journal atomicity, cross-storage ordering, and post-commit survival across process loss; they do **not** by themselves prove physical power-loss durability if underlying disk write caches, mount options (`nobarrier`), network filesystems (NFS), or virtualized storage ignore or reorder `fsync`/barrier requests. Same-user malicious writes, disk corruption beyond local checksums, and undisclosed background side effects of arbitrary worker tools are outside the guarantee.
