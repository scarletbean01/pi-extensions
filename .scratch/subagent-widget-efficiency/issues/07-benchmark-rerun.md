# 07: Rerun the token benchmark and record the savings

**What to build:** The token benchmark is rerun against the finished widget and the results are recorded beside the existing baseline, so the saving is measured. No source code changes.

Spec: `../spec.md` (user story 28; Testing Decisions).

**Blocked by:** 02 (lean launch), 03 (final-message delivery and coalescing), 06 (tool schema change, or its recorded revert)

**Status:** done

**Delegation tier:** easy (measurement and documentation from session files, procedure already documented) → codex `gpt-6-luna` at `model_reasoning_effort=high`; Opus review at medium effort.

- [x] The no-op, two-parallel-reads and two-reads-and-join workloads are run on the finished code using the method already in `docs/token-benchmark/README.md`.
- [x] First-turn input tokens for the no-op subagent are recorded beside the 5,175 baseline. The target is about 2,000 or fewer; if it is higher, the document says by how much and which remaining content explains it.
- [x] The number of parent LLM turns for the parallel workloads is recorded beside the baseline and shows the coalescing effect.
- [x] Figures that cannot be recomputed from retained session files are flagged as quoted, not measured, and the evidence session files are kept where pruning will not delete them.
- [x] No source code changes. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale token or cost claims. Status is set to done and verified criteria are ticked on merge.

**Verification:** Ran one scored finished-widget session per scripted workload with `timeout 240s pi --no-extensions -e <absolute-worktree>/subagent-widget.ts --mode rpc --model openai/gpt-6.1-terra --thinking low` from `/home/deplague/Projects/log-rotator`, plus one completed model-dispatched parallel-read session. One earlier no-op call completed before its transcript copy was in place, and an initial model-dispatched control stopped after the launch turn during RPC event handling correction; both are excluded and described in the README. Copied the baseline sessions from `~/.pi/agent/sessions/subagents` to `docs/token-benchmark/evidence/baseline/` and every scored rerun child session to `docs/token-benchmark/evidence/rerun/` before `/subrm` or `/subclear`. Seventeen evidence JSONL files are retained: five baseline sessions, eight rerun child sessions, and four rerun parent transcripts. The README records the RPC message format, relevant environment and file inputs, and extraction snippet. The no-op first request measured 1,896 uncached input tokens, 104 below target. Parallel worker tokens fell 13,192 in the retained one-run session comparison, and read-plus-join worker tokens fell 16,490; parallel worker cost increased by $0.0012784 because the rerun had no cache reads. The model-dispatched parent used two turns: one terminating launch turn and one batch wake-up. No baseline parent transcript survives, so its absolute turn count remains quoted, not measured. No source changes were made; the log-rotator checkout was left untouched. The 17 transcripts were structurally redacted with `docs/token-benchmark/redact-evidence.py`: private skills, project context, and global rules were replaced with byte-count placeholders, and other home paths normalized. All files parse as JSONL, usage snapshots are unchanged, the requested sensitive-string scan and checks for removed private sections found no matches, and the README extraction snippet reproduces the retained figures. No child process or Herdr pane was left behind.
