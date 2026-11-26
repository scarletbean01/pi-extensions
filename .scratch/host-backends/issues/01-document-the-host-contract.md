# 01: Document the Host contract

**What to build:** A maintainer can read one document and know exactly what a Host must do, how the Herdr and hc backends each do it, and which hc behaviours are still unverified. Documentation only; no behaviour changes.

- The Host contract document describes every Host operation (preflight, launch a node, report whether a node's terminal exists, close a node, send a wake-up, discover a run's owned nodes). For each one it shows the Herdr command and the hc command side by side with the semantic differences: ids compact on Herdr and are stable on hc; Herdr closes a tab or pane while hc hangs up then removes; the two status vocabularies; and that `hc send` presses Enter itself, waits for a person's draft and refuses a blocked terminal.
- It documents backend selection (explicit setting, then calling context, then hc if present, hc winning when both contexts exist), the frozen `host_backend`, the manifest fields (unchanged Herdr fields plus an opaque per-launch reference), and that a manifest with no recorded backend reads as Herdr.
- It documents hc node naming and labels, environment via the launcher script, independent nodes, ownership by label and terminal id, and discovery by label then confirmation.
- Every hc behaviour carries a **verified** or **unverified** tag with its source (help text, schema, or "not documented"): the note wrapper on `hc send`, the status-report wire format, the test-isolation recipe, and sending to a booting agent.
- It states the non-goals: remote hc and moving the session directory out of the checkout.
- The bootstrap README and the factory launch and guide documents drop their Herdr-only wording and link to the contract document. The glossary and ADRs are already written and are not changed.

Spec: `../spec.md`. Vocabulary: **Host**, **Host backend**, **Resource closure**. ADR 0004.

**Blocked by:** the `coms-handoff-reliability` work merged to `main`.

**Status:** done

- [x] The contract document covers every Host operation with both command lines side by side and the id, closing and status differences.
- [x] Backend selection and manifest compatibility are documented as decided.
- [x] Every hc behaviour is tagged verified or unverified with its source.
- [x] The README and the factory launch and guide documents no longer describe Herdr as the only Host and link to the contract document.
- [x] No code changes.
