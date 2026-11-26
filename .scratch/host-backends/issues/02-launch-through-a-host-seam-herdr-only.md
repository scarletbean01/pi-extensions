# 02: Launch through a Host seam (Herdr only)

**What to build:** Every Herdr command-line interaction sits behind the Host interface, and a run launches, reports, cleans up and recovers exactly as it does today. This is the prefactor that makes the hc backend an addition rather than an edit.

- The Host interface and a Herdr backend. The workspace check, node launch, discovery with its fallback, ownership matching, closing with its refetch, and the "leave a rearranged tab alone" rule all move into the Herdr backend. The orchestration code talks only to the Host.
- The existing injectable executor stays the seam to the command line, so the current fake Herdr executors keep working unchanged.
- The manifest records the chosen backend and an opaque per-launch reference that mirrors the existing Herdr fields. A manifest with no recorded backend reads as Herdr. Cleanup by tab id, the status views and reports behave as before.
- Backend selection follows the decided rules and is unit-tested with injected environments. Only Herdr is selectable for now; choosing hc fails with a clear "not available yet" message.
- Existing preflight failure wording is kept where tests assert it.

Spec: `../spec.md` (backend choice, the Host interface). Contract document from ticket 01. ADR 0004.

**Blocked by:** 01

**Status:** done

- [x] No `herdr` command-line call remains outside the Herdr backend (verified by search).
- [x] The existing deterministic and runtime suites pass with no change to their assertions (the known web-viewer guard hang is checked against `main`). *(Only the two historical compat-literal manifest snapshots in `bootstrap/lifecycle.test.ts` and `bootstrap/graph-fanout.test.ts` were updated to reflect the new `host_backend` / `host_ref` manifest fields.)*
- [x] New manifests record the backend and per-launch reference; a manifest without a recorded backend reads as Herdr; cleanup by tab id still works.
- [x] Backend selection rules are unit-tested with injected environments, and choosing hc is rejected with a clear message.
- [x] Documentation moved or updated where behaviour descriptions changed.
