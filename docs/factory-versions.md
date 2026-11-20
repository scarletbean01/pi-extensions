# Publishing and restoring versions without rebinding accepted work (ticket 04)

A factory keeps a stable ID while its definition evolves. Each published definition is an immutable, numbered version (`v1`, `v2`, ...); a separate current pointer says which version new admissions bind. Publishing never starts, resumes or takes over anything, and never rewrites work that was already accepted.

## Operator commands (direct human Pi commands only)

| Command | What it does |
| --- | --- |
| `/factory update <factory-id>` | Opens an editor for JSON `{ "draft": { ...bootstrap_generate fields... } }`, validates it exactly as `/factory publish` does, asks for confirmation, and commits the next version and the current pointer together. |
| `/factory restore <factory-id> <version>` | Re-validates the preserved `<version>` and republishes its saved payload, byte for byte, as the next new version. |
| `/factory inspect <factory-id> [version]` | Read-only. Shows the current version, or one retained version, plus the version list, queue and head status. |

Both mutating commands need an interactive Pi session with a UI, are refused in Bootstrap worker sessions, and ask for a human confirmation that names the factory, its ID, the version it would replace and the new version it creates. The confirmed current version is passed to the commit as a guard: if another publication moved the pointer while the confirmation was open, the commit is rejected (`current version changed from vN to vM`) and nothing is written. The model-facing `factory_inspect` tool has no update or restore action, so an agent can read versions (`inspect` accepts an optional `version`) but cannot publish, restore or consent for an operator.

## Guarantees

- **One durable commit.** The new version row and the current pointer commit in one transaction. A failure before commit leaves the prior pointer and every prior version intact. A failure after commit (lost acknowledgement) is reported as an uncertain outcome; `/factory inspect <factory-id>` shows what committed, and the guard above makes a repeated confirmation safe.
- **Versions increase under the stable ID** and are never edited, deleted, revoked or rewound. A restore creates a *new* version whose `restored_from_version` names the source and whose digest equals the source's.
- **Publication does not touch management or the queue.** An unmanaged factory stays unmanaged, a managed one keeps its manager, and queued or running inputs keep the version they were bound to.
- **Admission races publication in durable order.** Each receipt binds exactly the version that is current at its own commit; an identical retry returns the original receipt and binding even after later publications. A changed brief under the same reference is still a conflict.
- **Restore validates before it writes.** The saved payload's integrity (digests, envelope) and the live prerequisites and operator ceilings that launch would check are verified first. A damaged, missing or incompatible target, a target that is already current, or an unknown version token is rejected without mutation, and nothing is re-resolved from drafts, personas, aliases or defaults, so tool, skill and extension policies (including inherit markers) are exactly as saved.

## Launch consumes the bound version

The FIFO head launches from the retained definition of the version it was bound to, even when a later version is current. Preflight, reservation, the release gate, the worker-side release reader, and the run's `factory_managed` metadata all carry that bound version and must agree. A mismatch (for example a changed manifest `bound_version`, or a missing or damaged version record) blocks release, and the run is reported as `uncertain`. `release.json` records the `bound_version` it released; a later-version (`v2`+) marker that lacks it, or names another version, no longer verifies and the run reads as `uncertain`. Legacy `v1` markers written before the field existed stay valid. A bound version that is missing, damaged, or fails live checks (missing checkout, `coms_extension`, extension paths, operator `graph.ceilings`, ...) blocks the head with the cause (`head_status.blocking_kind` `uncertain`, `compatibility`, `preflight` or `ceiling`) and `launch` refuses without skipping it, substituting the current version, another input, model or limit, or consuming capacity. Live prerequisites are not frozen: once they are satisfied again the same head launches unchanged.

## Observability conventions

Bound and current versions are always separate fields; neither is inferred from the other.

- **Receipts and queue:** `bound_version` and `current_version` on each receipt and queue entry (`/factory receipt`, `/factory inspect`, `factory_inspect`). Receipt recovery needs only its own intact records: if the current pointer (or an unrelated version) is damaged the receipt is still returned, without a `current_version` rather than a guessed one.
- **Head status:** `head_status.bound_version`, `head_status.current_version`, and the blocking cause.
- **Queue policies:** `bound_policies` in `inspect` gives the per-node policies of every retained version the queue or attempts are bound to (keyed by version), separate from `node_policies` of the inspected (by default current) version.
- **Attempts:** each attempt shows its `bound_version`, the `current_version`, and `node_policies` for the *bound* version.
- **Run status and report:** `bootstrap_status` and the read-only `bootstrap_report` (below) for a factory-managed run add a `Factory version: bound vN; current vM` line and the same `factory_binding` detail, from one shared lookup (read-only; it never resumes management, repairs evidence or migrates storage). If the bound version record is missing or damaged, they say so and still show the current version separately. If only the *current* version (or the current pointer) is damaged while the bound version is intact, the bound version's per-node policies are still shown and the current version is reported as unverifiable (`current_error`, `current_version` absent when the pointer itself is lost); neither is inferred from the other.
- **Which state database answers:** the binding comes from the run's own recorded `state_db_path` when that differs from the observing session's default factory store (a run launched under another `PI_FACTORY_STATE_DIR` / `PI_BOOTSTRAP_STATE_DIR` root, or an observer started after a migration), and the response names that path. A recorded path is trusted only while the run's release evidence verifies; when the evidence is uncertain (for example the primary manifest and run-local sidecar disagree on the path) and the path differs from the observer's store, it is not followed and the binding is reported unverified.
- **Inheritance markers:** `node_policies` and the status line state, per node, whether tools and skills are `declared` (and which) or inherit live Pi availability, and that extensions are inherited plus declared additions. `runtime_assumptions.not_frozen` lists what a version does not freeze: the Pi runtime, tool and skill availability, installed extension and skill contents, provider catalog and credentials, and checkout contents.
- **Inspect with a damaged current version:** when the current pointer is intact but the current version's record is missing or corrupt, `/factory inspect` and `factory_inspect` still return the queue, receipts, attempts and head status. The head is blocked with the cause (`head_status.blocking_kind` `uncertain`) when it is bound to the damaged version; `current_error` and `inspected_error` say what cannot be verified, `definition`/`node_policies` are omitted for the damaged version instead of showing another version's data, and `bound_policies` still lists every intact bound version. When the head's own definition is unavailable, checkout/capacity evidence is computed against a labelled stand-in (`checkout_evidence_stand_in` names the version used). A lost or damaged current *pointer* is not read around by `inspect` (it fails closed as before). Launch, admission, update and restore still require an intact pointer and current version and refuse without writing.
- **Version list:** `versions` in `inspect` lists every retained version with its digest, creation time, `restored_from_version`, and a `corrupt_reason` for a damaged one (the read still succeeds so the evidence can be seen; writes that need the damaged history fail closed).

## Storage

Versions live in `factory_versions` and the pointer in `factory_pointers` (SQLite schema v5, record digests like the other factory records). Existing stores upgrade lazily inside the first `update` or `restore` transaction, keeping the original `v1` payload verbatim; v4 stores without versions keep working and are `v1` only. Read-only operations never upgrade a store.

## Reporting on factory-managed runs

`bootstrap_report` with a factory-managed `task_id` is a **read-only report**: it reads the recorded status and per-node results and returns a structured report plus human text. It never writes `report.json`/`report.md`, reconciles or persists run state, accepts replacement `results`, cleans up, delivers, or uses authority. Passing `results` or `write_markdown` (even `false`, which for standalone runs deletes `report.md`) is refused without effect. The report shows, per node, the recorded result or the not-executed record; the run outcome comes from every node (not from the entries that happen to have results); and the bound-versus-current versions and per-node tool/skill policies from the shared binding lookup above.

Evidence is never turned into success. `details.status` is `read_only` only when every node's outcome is recorded and nothing is pending or in error; otherwise it is `read_only_incomplete`, `details.issues` lists why (pending nodes, delivery or worker errors, nodes with no recorded result, an uncertain or errored run), the text is headed "INCOMPLETE or uncertain" and the call is marked as an error when the run itself is in an error/uncertain state. A damaged or unreadable review-loop record fails the report closed.

The persisted-report service method (`BootstrapService.report`) is unchanged for standalone runs and still refuses factory-managed runs (ticket 03's direct-mutation guard), as do cancel, cleanup, retry and `bootstrap_generate` replay.

## Known limits of this slice

- There is no persisted report artifact for factory-managed runs; the read-only report is regenerated from recorded evidence each time.
- There is no stop/pause control or launch-retry/clearance command yet; publication simply does not change management state.
- Restore of the version that is already current is rejected rather than creating a duplicate.
