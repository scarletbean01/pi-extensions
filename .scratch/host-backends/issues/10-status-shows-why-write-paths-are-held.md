# 10: Status shows why write paths are held

**What to build:** When a loop is paused on a **Human wait** and a downstream writer is waiting for its write paths, `bootstrap_status` says so.

- The status line for a node waiting on contested write paths names the holder and states when the holder is waiting for a person (a direction request is pending), not merely "running" or "uncertain". The text view and the structured report both carry it.
- No planning warning about shared root manifests is added.
- Existing wording for ownership waits and human waits is otherwise unchanged.

Spec: `../spec.md` (hygiene).

**Blocked by:** the `coms-handoff-reliability` work merged to `main`.

**Status:** done

- [x] A graph where a loop awaits a person and a later node needs the same write paths reports, through `bootstrap_status`, that the later node waits on the loop's human wait.
- [x] A holder that is simply running, or uncertain, is described as before.
- [x] Existing status and ownership tests pass; documentation is updated.
