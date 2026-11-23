# 16: Enforce write scope mechanically

**What to build:** A project can opt in to a built-in check that fails an attempt whose changes fall outside its node's declared `write_paths`, so scope is enforced by evidence and not by a line in the prompt. This is a post-release extension; it does not gate [ticket 14](14-verify-and-document-in-pi-herdr.md). See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [06: Cancel a run and verify settlement](06-cancel-a-run-and-verify-settlement.md). Do not start before ticket 06 merges: both change `bootstrap/lifecycle.ts`.

**Status:** deferred (frozen for the current release; user decision 2026-11-22)

- [ ] Add a project setting in `.pi/bootstrap.json`, `enforce_write_scope`, off by default for this release. Resolve it through the same request, project, global order and operator ceilings as other limits.
- [ ] When on, after each attempt of a node that declares `write_paths`, compare the changed paths from the existing before/after working-tree evidence snapshots with the declared paths. Any changed path outside them fails the attempt as a scope violation that names the paths and the node.
- [ ] A scope violation is evidence, not a model judgement. It blocks dependants like any failed required check, and it stales earlier passing evidence. An unknown change scope is unverified, as with other checks, and never passes.
- [ ] In a review loop the violation reaches the next revision as part of the builder's findings, together with an explicit scope line naming the allowed paths. It does not create a second return path or return other nodes.
- [ ] When off, report each would-be violation as a warning in the run report and change no outcome. Record the future default change in the migration notes.
- [ ] Cover an in-scope pass, an out-of-scope fail, a violation inside a review loop, an unknown scope, a node with no `write_paths`, and the off setting producing warnings only. Check that tickets 03–05's launch-evidence behavior is unchanged.
