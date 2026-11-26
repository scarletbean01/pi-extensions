# 07: hc status extension

**What to build:** Under hc, an agent reports its status to hc so it shows correctly in hc's own views. The reporting is advisory and never affects workflow state (ADR 0003).

- A separate extension, beside the Herdr-managed state extension (which Herdr overwrites and which is never edited), is enabled only when the hc terminal identity is set and does nothing under Herdr or in an ordinary shell.
- It reports working during a turn, idle when the turn settles, blocked on a direction request and done on completion.
- The wire format comes from ticket 05's verified live findings (`hc 0.1.22`, `bootstrap-hc-findings-6bLWs8`):
  - Emit only when `HC_TERMINAL_ID` is set (never under Herdr or in an ordinary shell).
  - Format: `ESC ] 7501 ; state=<word>[:key=value…] ST` (`\x1b]7501;state=<word>[:key=value…]\x1b\\`, ST terminator).
  - States to emit: `working`, `idle`, `blocked`, `done` (plus `error` supported by `hc`).
  - Allowed extra keys: `app=<s>` (shown in `hc get` `status.app` and `hc ls` `agent`), `progress=<int>` (shown in `status.progress`), `kind=<permission|question|auth>` on `blocked` (shown in `status.kind`).
  - Forbidden keys: `msg` and `title` (`hc` rejects the entire record when either is included, with empty `core.log`).
  - `message`: accepted by `hc` without appearing in `hc get` `status` (visible effect unverified; do not rely on it).

Spec: `../spec.md` (status publishing).

**Status:** done

- [x] With the hc terminal identity set, the extension emits the documented reports for each mapped event (verified by capturing terminal output).
- [x] Without the hc terminal identity, nothing is emitted.
- [x] The Herdr-managed state extension is unchanged.
- [x] The documentation describes the extension and its advisory role.
