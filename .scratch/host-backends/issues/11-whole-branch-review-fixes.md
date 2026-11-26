# 11: Whole-branch review hardening round

**What to build:** Address findings from the whole-branch code review across `host-herdr.ts`, `host-hc.ts`, `pane-wake.ts`, `handoff.ts`, `bootstrap.ts`, tests, and docs.

- `HerdrHost.sendWakeUp` uses `this.asWakeExec()` (`this.exec`) instead of bypassing it with `defaultHerdrExec`; `HerdrHost.command` passes `env: this.env`; `PaneWakeExec` is unified with `HostExecutor` (no `as HostExecutor` casts in `host-hc.ts` or `pane-wake.ts`; both `timeout` and `timeoutMs` are passed). Contract test exercises wake-up through the Host executor seam on both backends without a `herdr`-only binary branch.
- `HcHost.getTerminal` and `HcHost.preflight` verify the returned `address` equals the requested address so a recycled-name look-alike is never resolved by name, treated as `gone` / failed preflight instead of `ambiguous` or adopted.
- Model-facing tool descriptions in `bootstrap.ts` use backend-neutral vocabulary (`Host`/`terminal`/`node`) and state that `tab_ids` is Herdr-only and refused on `hc` runs (`tools.test.ts` and `docs.test.ts` synced).
- `docs/factory-guide.md`, `docs/factory-launch.md`, and `bootstrap/README.md` drop ticket-01 Herdr-only placeholder wording and point to `bootstrap/HOST.md` with `hc` implemented.
- Ticket 06 test gaps closed: `not_found` from `hc send` maps to `skipped` on the send path itself, `sent` result carries `host_ref`, `<hc …>` wrapper without `from` is rejected, claimed/missing offer prevents `hc send`, and `HcHost` `runRaw` env/timeouts for `launch`/`ls`/`get` are verified unchanged.
- Ticket 05 test hygiene verified: `bootstrap/hc-live-isolation.test.ts` `makeEnv` (line 461–463) already cleans up `/tmp/bootstrap-hc-harden-escalate-kill-*` via `t.after(() => rmSync(...))` (confirmed by running `bootstrap/hc-live-isolation.test.ts`, which left no new `/tmp/bootstrap-hc-harden-*` directories; the single pre-existing `/tmp/bootstrap-hc-harden-escalate-kill-zpbmgu` predates commit `8e6b0a8`).

- Ticket 10 follow-up (`feature/host-backends-10`, commit `8d4f0c3`) merged and finished: `bootstrap/reporting.ts` passes `w.status === "uncertain"` instead of hard-coded `true` for `held_uncertain` holders; `bootstrap/tools.test.ts` updated from `wait_reason` to `human_wait_node_id` and expanded with tests for mixed plain-running + uncertain holders on `held_uncertain`, non-loop holders with `wait_reason === "human"`, and the `holder.status !== "running"` guard; `bootstrap/README.md` documents both single-holder (`X (waiting for a person)`) and loop-held (`<holder> (loop waiting for a person at <requesting_node>)`) human waits plus the `ownership_waiting_on[].wait_reason: "human"` -> `human_wait_node_id: string` rename; ticket 10 issue note updated accordingly.

Spec: `../spec.md`. ADR 0003 and 0004. `bootstrap/HOST.md`.

**Status:** done

- [x] Item 1: `HerdrHost.sendWakeUp` uses injected `this.exec`, `HerdrHost.command` passes `env: this.env`, `request.exec` typed without `as HostExecutor` casts, contract test uses executor seam for both backends, existing Herdr wake-up tests unchanged.
- [x] Item 2: `HcHost.getTerminal` and `HcHost.preflight` confirm returned `address === requested`, with contract tests for recycled-name look-alikes (never adopted/cleaned, reports `gone`, preflight rejects).
- [x] Item 3: Model-facing tool descriptions in `bootstrap.ts` are backend-neutral and state `tab_ids` is Herdr-only and refused on `hc` runs; synced with `tools.test.ts` / `docs.test.ts`.
- [x] Item 4: `docs/factory-guide.md`, `docs/factory-launch.md`, and `bootstrap/README.md` updated to remove Herdr-only placeholder wording and reflect implemented `hc` support; `docs.test.ts` passes and covers it.
- [x] Item 5: Ticket 06 test gaps covered (`hc send` `not_found` -> `skipped`, `sent.host_ref`, `<hc …>` without `from` rejected, claimed/missing offer prevents `hc send`, `HcHost` `runRaw` env/timeouts unchanged for `launch`/`ls`/`get`).
- [x] Item 6: Ticket 05 `bootstrap/hc-live-isolation.test.ts` `/tmp/bootstrap-hc-harden-escalate-kill-*` cleanup verified (already fixed in `makeEnv` via `t.after`, no code change needed).
- [x] Item 7: Merge `feature/host-backends-10` (`8d4f0c3`), fix `ownershipHolderText(w, w.status === "uncertain")` in `bootstrap/reporting.ts`, update `bootstrap/tools.test.ts` (`human_wait_node_id`), add tests for non-loop `wait_reason === "human"` and `holder.status !== "running"` guard with mutation checks, update `bootstrap/README.md` and ticket 10 file.
