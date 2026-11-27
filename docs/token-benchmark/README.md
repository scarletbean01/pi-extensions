# Read-only token benchmark

Subagent session files are deleted when their subagent is removed and pruned after seven days. Copy any transcript needed as evidence out of the sessions directory first, for example: `mkdir -p docs/token-benchmark/evidence && cp "$HOME"/.pi/agent/sessions/subagents/subagent-*.jsonl docs/token-benchmark/evidence/ 2>/dev/null || true`.

This note records the pre-ticket-01 Bootstrap baseline and one post-ticket-01 rerun of each graph workload. The rerun uses the installed extensions, which include commit `91bf201`. Baseline manifests were created from 09:26–09:29Z, before `ccb44d6` (09:59Z) and the `91bf201` merge (10:15Z); rerun manifests were created from 10:27–10:28Z. All workloads were read-only and used `openai/gpt-6.1-terra` with low thinking.

## Setup and prompts

The benchmark compared a fresh `subagent-widget.ts` agent with Bootstrap graph nodes. Runs used Pi 1.6.1, `hc` 0.1.22, and the `/home/deplague/Projects/log-rotator` checkout. Graph runs used `topology: "graph"`, `task: "Read-only token benchmark"`, `goal: "Return short exact answers for a matched token trial."`, `constraints: ["Do not edit project files."]`, `cleanup: "manual"`, and `task_timeout_ms: 60000`. Each graph node used persona `scout`; its `terra` alias resolved to `openai/gpt-6.1-terra`, thinking `low`. The persona enabled `read`, `grep`, `find`, `ls`, and `bash`, with an empty skills list. Bootstrap and Coms added their runtime tools. The original harness set `request_id` to `token-bench-<trial ID>`; the post-change rerun used fresh idempotency keys so it could not reuse a baseline run. `request_id` does not change the node prompt.

The widget created a fresh Pi session per node through `/sub`, using five read-only built-in tools, no extensions, and the default skill descriptions. Its recorded read workers use `openai/gpt-6.1-terra` with low thinking. The retained no-op baseline session is an exception: it records `gpt-6.2-sol` and a different prompt, as detailed under ticket 07 below. The widget reported each result to the parent as a model-triggering follow-up. These are not identical system prompts: the redacted baseline session placeholders preserve a 17-entry skills inventory's original 12,671-byte size; `scout` had no skills.

The persisted graph node prompts were:

**No-op node** (`node_id: "noop"`, no reads or dependencies):

```text
Return the literal BENCH_READY as the answer. Do not read any files. This is a read-only benchmark. Do not write any files or run unrelated tools. Call bootstrap_complete with status success, the exact answer as summary, and a short detail. Trial ID: 0291adb755-1-noop-graph.
```

**Two parallel read nodes** (`rust` reads `Cargo.toml`; `ui` reads `ui/AGENTS.md`; neither depends on the other):

```text
Use the read tool once on Cargo.toml (offset 1, limit 6). Give [package] name and edition as name|edition. This is a read-only benchmark. Do not write any files or run unrelated tools. Call bootstrap_complete with status success, the exact answer as summary, and a short detail. Trial ID: 0291adb755-1-read-graph.
```

```text
Use the read tool once on ui/AGENTS.md (offset 1, limit 7). Give frontend language and bundler as language|bundler. This is a read-only benchmark. Do not write any files or run unrelated tools. Call bootstrap_complete with status success, the exact answer as summary, and a short detail. Trial ID: 0291adb755-1-read-graph.
```

**Two reads plus a join** uses the same read tasks with trial ID `0291adb755-2-join-graph`. The `join` node depends on `rust` and `ui` with `join_policy: "all_success"`; it does not read project files:

```text
Combine the two upstream answers, in Rust-then-UI order, with a single | separator and no spaces. Do not read any project files. Use the accepted upstream result summaries from the admitted handoff; if they are not visible, retrieve them with bootstrap_read_input. This is a read-only benchmark. Do not write any files or run unrelated tools. Call bootstrap_complete with status success, the exact answer as summary, and a short detail. Trial ID: 0291adb755-2-join-graph.
```

Expected summaries: `BENCH_READY`; `log-sidecar|2024`; `TypeScript|esbuild`; and `log-sidecar|2024|TypeScript|esbuild` for the join.

The widget used the task-specific text below, with the same common suffix on each prompt: `This is a read-only benchmark. Do not write any files or run other tools. Reply with the answer only, no markdown.` Its trial suffix was `-widget` rather than the graph prompt's `-graph`.

- No-op: `Return the literal BENCH_READY as the answer. Do not read any files.`
- Rust read: `Use the read tool once on Cargo.toml (offset 1, limit 6). Give [package] name and edition as name|edition.`
- UI read: `Use the read tool once on ui/AGENTS.md (offset 1, limit 7). Give frontend language and bundler as language|bundler.`
- Join: `Combine the two upstream answers, in Rust-then-UI order, with a single | separator and no spaces. Do not read any project files.` The prompt appended `Rust answer: log-sidecar|2024. UI answer: TypeScript|esbuild.` from the two successful readers; the parent did not synthesize the join.

In the scripted phase, `/sub` was invoked directly and Bootstrap generate/status/cleanup were called without a model dispatch. In the separate model-dispatched read comparison, each parent had `subagent_create`, `bootstrap_generate`, `bootstrap_status`, and `bootstrap_report`. The widget parent spawned two readers; the graph parent launched one already dry-run plan and made one blocking status call. Both parents returned the same combined answer. That comparison was two parallel reads plus a parent summary, not a three-node join.

## Pre-change baseline and post-change rerun

The `read-only-token-benchmark-*.json` glob in `~/.pi/agent/bootstrap-sessions/` matches 16 files: the 13 baseline IDs listed here and the three rerun IDs listed below. Their `session_dir` points to each run's immutable node inputs, readiness records, results, and manifest under the `log-rotator` checkout. The node `.input.json` files preserve each graph prompt; `.ready.json` records the resolved model and Coms session ID. The Pi session transcript for an agent is in the project session store matching `~/.pi/agent/sessions/--home-*-Projects-log-rotator--/`.

The 13 manifests comprise three scored scripted no-op runs, three scripted parallel-read runs, three join runs, three model-dispatched parallel-read graph runs, and one earlier no-op shakedown. Their task ID suffixes are: scored no-op `4360d378`, `ca371100`, `df2eefd9`; scripted reads `ef98575a`, `e29a64b4`, `aed3b6c6`; model-dispatched graph reads `bc82d887`, `b49c6fb0`, `b9737abe`; joins `84b70ebe`, `377cbdb0`, `76a803b7`; excluded shakedown `4c3e1753`. Each full ID starts with `read-only-token-benchmark-`. The shakedown is excluded from the scripted medians. The baseline figures below are the median of three scored scripted graph runs; ranges are included to show their spread. The no-ack column is an estimate recomputed from those transcripts by removing each node's final stopping response, which acknowledged `bootstrap_complete` after its result had been saved.

| Workload | Pre-change graph tokens, median (range) | Without final acknowledgments, estimated | Post-change graph tokens, one run | Tokens saved vs. pre-change median | Difference from estimate | Pre-change Pi cost (token-median run) | Cost saved (amount; percent) | Post-change Pi cost estimate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| One no-op node | 7,526 (7,518–7,530) | 3,750 | 3,765 | 3,761 | +15 | $0.0042732 | $0.0003442 (8.1%) | $0.003929 |
| Two parallel reads | 23,933 (23,915–23,987) | 15,838 | 15,918 | 8,015 | +80 | $0.0100906 | $0.0007950 (7.9%) | $0.0092956 |
| Two reads plus a join | 34,319 (34,225–34,447) | 21,082 | 21,190 | 13,129 | +108 | $0.0160102 | $0.0013762 (8.6%) | $0.014634 |

Cost savings of 7.9–8.6% are much smaller than token savings of 33.5–50.0%, because the dropped acknowledgment turns were mostly cached input (directionally consistent with the ~4.5% model-dispatched estimate in `.scratch/bootstrap-complete-terminate/spec.md`). The cost column uses the run with the median token count, not the median cost. Cache hits vary between runs: the rerun no-op and join nodes had 0 cached input, and the pre-change join runs alone ranged from $0.0160 to $0.0236, so a single run's cost is noisy.

The post-change runs used the same graph topology, node IDs, task prompts, read paths, dependencies, persona, and model. Each was one launch; all nodes succeeded, each graph report was collected, and each run was cleaned up with its session files retained. The run IDs are:

- No-op: `read-only-token-benchmark-69ff937e-c477-473d-8014-14676e59570f`
- Parallel reads: `read-only-token-benchmark-57f7f4a9-2a04-44b7-9760-a3927585bc70`
- Reads plus join: `read-only-token-benchmark-2c947f8c-463f-429d-bbaf-46e2e1acd420`

Baseline repeats varied the trial number (`-1`, `-2`, and `-3`); the rerun reused the trial IDs `0291adb755-1-noop-graph`, `0291adb755-1-read-graph`, and `0291adb755-2-join-graph` (the `-1-noop`, `-1-read`, and `-2-join` IDs).

Baseline worker transcripts for the scored runs ended with a text acknowledgment turn after each `bootstrap_complete` call, with `stopReason: stop`. The excluded no-op shakedown (`4c3e1753`) instead ends on an `aborted` entry. Rerun worker transcripts end on the `bootstrap_complete` `toolUse` with no acknowledgment turn. The rerun join's wait for its second inbound handoff left a zero-usage aborted transcript entry; it made no extra model request and contributes no tokens. The same zero-usage aborted entry appears in baseline join transcripts (for example, `377cbdb0`), so it predates ticket 01. Post-change agent totals exclude the dispatcher model calls used to plan, report, and clean up these runs.

## Widget comparison

The scripted widget and graph comparison below is from three matched repeats per workload. Widget parent usage is included in its total because the widget delivered model-triggering follow-ups; the scripted graph parent made no model calls. Graph agent totals are recomputed from the retained Bootstrap sessions. Widget and parent values are quoted from the earlier benchmark record because the 13 baseline Bootstrap manifests do not contain those transcripts.

| Scripted workload | Widget agents | Widget parent | Widget total | Graph agents | Graph parent | Graph total | Graph total difference |
|---|---:|---:|---:|---:|---:|---:|---:|
| No-op | 5,204 | 1,502 | 6,706 | 7,526 | 0 | 7,526 | +12.2% |
| Parallel reads | 21,131 | 3,146 | 24,277 | 23,933 | 0 | 23,933 | −1.4% |
| Reads plus join | 26,381 | 4,912 | 31,293 | 34,319 | 0 | 34,319 | +9.7% |

The separate model-dispatched comparison covers parallel reads and parent synthesis. Its end-to-end figures are quoted from the earlier analysis: the graph used 6.6% fewer total tokens (quoted) but had 67% higher Pi-estimated cost (quoted). The graph agent median of 23,961 tokens is recomputed from its three `e075652a1b` graph sessions; all other values in the table are quoted because the graph parent and widget ledgers are not in the retained Bootstrap manifest set. The first three token rows are medians. The uncached/cached/output row gives per-workflow mean tokens across three repeats, so the graph components sum to 45,911 rather than the separately reported 45,914 total-token median.

| Model-dispatched parallel reads | Widget | Graph |
|---|---:|---:|
| Agent tokens (median) | 21,135 (quoted) | 23,961 (recomputed) |
| Parent tokens (median) | 28,045 (quoted) | 21,953 (quoted) |
| Total tokens (median) | 49,180 (quoted) | 45,914 (quoted) |
| Uncached input / cached input / output (mean tokens) | 8,133 / 40,747 / 298 (quoted) | 15,299 / 30,080 / 532 (quoted) |
| Cache share of input | 83.4% (quoted) | 66.3% (quoted) |
| Pi-estimated cost | $0.011662 (quoted) | $0.019461 (quoted) |

The widget's parent used one more model request than the graph parent in this dispatch case, which offset the graph's higher agent token count. Costs use Pi's model registry rates and are estimates, not provider invoices.

## Finished widget rerun (ticket 07)

The finished `subagent-widget.ts` on this branch was loaded explicitly from this worktree with `-e <absolute-worktree>/subagent-widget.ts`; other extension discovery was disabled. Each parent Pi run was wrapped in `timeout 240s`, used Pi 1.6.1, `openai/gpt-6.1-terra`, low thinking, and ran in `/home/deplague/Projects/log-rotator`. The three scripted workloads used the exact widget prompts and read paths above. `/sub` was submitted directly over Pi RPC, so there was no model call to launch each scripted subagent. The extension's model-triggered result follow-ups were allowed to run and are included in the end-to-end totals below. One fresh subagent was used for no-op, two fresh subagents for parallel reads, and two readers plus a fresh join subagent for reads plus a join. Each child session was copied before `/subrm` or `/subclear` removed it. The four original baseline session files used below are retained in [`evidence/baseline`](evidence/baseline/); the extra baseline file is an aborted `clear` session and is excluded. Rerun child and parent transcripts are in [`evidence/rerun`](evidence/rerun/).

Run accounting: one initial no-op call completed before its child transcript was copied, so that deleted session is excluded and the retained no-op rerun is the scored run. An initial model-dispatched control was stopped after the launch turn during correction of RPC event handling; it did not reach the batch follow-up and is excluded. The scored evidence contains one retained scripted run per workload and one completed model-dispatched parallel-read run. There are 17 retained JSONL evidence files: 5 baseline, 8 rerun child, and 4 rerun parent transcripts.

### Baseline model and prompt provenance

The component table compares one retained baseline worker-session set with one rerun per workload. Baseline parallel-read workers are the Cargo.toml and ui/AGENTS.md reader files also used in the baseline join set; they are not an independent baseline run. The baseline join adds the retained join worker. The prompt text below is taken from each copied baseline transcript; current task prompts are listed under Setup and prompts.

| Baseline workload/file | Recorded model and thinking | Stored user prompt |
|---|---|---|
| No-op: [`subagent-1-1795780342925.jsonl`](evidence/baseline/subagent-1-1795780342925.jsonl) | `openai/gpt-6.2-sol`; low | `Reply with BENCH_READY. Do not read or edit any files.` |
| Cargo reader: [`subagent-1-1795780122232.jsonl`](evidence/baseline/subagent-1-1795780122232.jsonl) | `openai/gpt-6.1-terra`; low | `Use the read tool once on Cargo.toml (offset 1, limit 6). Give [package] name and edition as name|edition. This is a read-only benchmark. Do not write files or run unrelated tools. Reply only with the exact answer, no markdown. Trial: matched-widget-vdiYyInu.` |
| UI reader: [`subagent-2-1795780122234.jsonl`](evidence/baseline/subagent-2-1795780122234.jsonl) | `openai/gpt-6.1-terra`; low | `Use the read tool once on ui/AGENTS.md (offset 1, limit 7). Give frontend language and bundler as language|bundler. This is a read-only benchmark. Do not write files or run unrelated tools. Reply only with the exact answer, no markdown. Trial: matched-widget-vdiYyInu.` |
| Join: [`subagent-3-1795780130007.jsonl`](evidence/baseline/subagent-3-1795780130007.jsonl) | `openai/gpt-6.1-terra`; low | `Combine the two upstream answers, in Rust-then-UI order, with a single | separator and no spaces. Do not read any project files. Rust answer: log-sidecar|2024. UI answer: TypeScript|esbuild. This is a read-only benchmark. Do not write files or run unrelated tools. Reply only with the exact answer, no markdown. Trial: matched-widget-vdiYyInu.` |

The no-op comparison crosses both model and prompt: the baseline is `gpt-6.2-sol` with the short prompt above; the rerun is `openai/gpt-6.1-terra` with the benchmark prompt under Setup and prompts. The 5,175 baseline input figure is retained from the spec and session, but this token difference does not isolate the code change. Its baseline cost of $0.010420 is from `gpt-6.2-sol`; the rerun cost uses `gpt-6.1-terra`, so the cost delta is omitted because the price difference confounds it. The read and join baselines and reruns use the same model, but their exact prompt suffixes and trial text differ; those token and cost changes are observations across prompt variants, not strict same-prompt deltas. The complete comparison therefore crosses prompt variants for every workload and crosses models for the no-op.

The component table reports worker-only sums. The earlier three-repeat widget medians remain in the prior table and are **quoted, not measured from retained files**; these baseline component values and rerun values are recomputed directly from the copied sessions. Cache reads and costs can vary between single runs.

| Workload | Baseline worker input / cacheRead / cacheWrite / output | Rerun worker input / cacheRead / cacheWrite / output | Worker total tokens: baseline → rerun (saved; % of baseline total) | Pi estimated worker cost: baseline → rerun (change; % of baseline cost) |
|---|---:|---:|---:|---:|
| One no-op node | 5,175 / 0 / 0 / 7 | 1,896 / 0 / 0 / 7 | 5,182 → 1,903 (3,279; 63.3%) | $0.010420 (`gpt-6.2-sol`, not comparable) → $0.001931 (`gpt-6.1-terra`); delta omitted |
| Two parallel reads | 5,816 / 15,232 / 0 / 75 | 7,856 / 0 / 0 / 75 | 21,123 → 7,931 (13,192; 62.5%) | $0.0069526 → $0.008231 (cost increased $0.0012784; 18.4%) |
| Two reads plus a join | 6,051 / 20,224 / 0 / 91 | 6,457 / 3,328 / 0 / 91 | 26,366 → 9,876 (16,490; 62.5%) | $0.0075172 → $0.0070784 (cost saved $0.0004388; 5.8%) |

The no-op worker's first assistant request used **1,896 uncached input tokens** (`cacheRead` was 0 in both sessions), down **3,279 input tokens (63.4% of baseline input)** from the 5,175 baseline and **104 input tokens below** the ~2,000 target. The worker total-token reduction is **3,279 tokens (63.3% of baseline total tokens)**. Its [saved session](evidence/rerun/noop/subagent-1-1795792215846-0-b8fedecd-5175-46f7-8d04-85306cb5d9a2.jsonl) contains redaction placeholders for private system sections. The project-context placeholder preserves its original 3,898-byte size; the four read-only tool schemas, Pi preamble and cwd remain, while the global-rules section is represented by a byte-count placeholder. No skill section is present in this rerun worker. The baseline files preserve a redacted 17-entry skills inventory with an original size of 12,671 bytes. The metadata still stores a `<docs>` section descriptor, but the child-docs extension strips the Pi docs section from the prompt before the model request; that filter is created by the launch code at `subagent-widget.ts` around line 888. These byte counts show which prompt sections were present and their original sizes; they do not give per-section token counts. The 1,896 input figure is the measured request before transcript redaction, and usage fields remain unchanged.

| Scripted workload | Earlier worker tokens (quoted median) | Earlier parent tokens (quoted median) | Rerun worker tokens (measured) | Rerun parent tokens (measured) | Rerun end-to-end tokens |
|---|---:|---:|---:|---:|---:|
| One no-op node | 5,204 | 1,502 | 1,903 | 5,310 | 7,213 |
| Two parallel reads | 21,131 | 3,146 | 7,931 | 5,442 | 13,373 |
| Two reads plus a join | 26,381 | 4,912 | 9,876 | 11,036 | 20,912 |

The earlier worker and parent values are the quoted three-repeat medians from the widget comparison above. Parent configuration is **not verified as matched to the earlier quoted run**: the redacted parent placeholders preserve a 17-entry global skills inventory from `~/.agents/skills` with an original size of 12,007 bytes, and the parent tool set includes `bash`, `edit`, and `write` (visible in [the rerun parent session, line 5](evidence/rerun/parent/noop-final/2026-11-27T15-10-15-738Z_01a21d8e-9eba-742c-83b6-284cead147b3.jsonl#L5)). The RPC command used `--no-extensions` but did not use `--no-skills`, so these global skills loaded and contributed to parent input totals. The earlier parent transcripts were not retained, so their skills and tool configuration cannot be compared. The numeric difference between earlier and rerun totals is not a controlled end-to-end delta; in particular, the no-op arithmetic difference of +507 tokens does not show that the widget makes no-op runs more expensive. Earlier parent cost ledgers were also not retained, so baseline end-to-end cost savings cannot be recomputed. Current parent estimated costs from retained sessions are $0.005338 (no-op), $0.005506 (parallel reads), and $0.006300 (read batch plus join); adding these to worker costs gives current one-run estimates of $0.007269, $0.013737, and $0.0133784. These remain Pi estimates, not provider invoices.

### Coalescing evidence

| Scripted workload | Parent LLM turns | `custom_message` result batches |
|---|---:|---|
| Two parallel reads | 1 | 1 message carrying both results ([transcript line 6](evidence/rerun/parent/parallel-reads/2026-11-27T15-12-37-108Z_01a21d90-c6f4-76aa-a75e-e08dbc05c153.jsonl#L6)) |
| Two reads plus a join | 2 | 2 messages: reader batch at [line 6](evidence/rerun/parent/reads-plus-join/2026-11-27T15-13-09-139Z_01a21d91-4413-7521-a2bf-0967bc22983b.jsonl#L6), join result at [line 8](evidence/rerun/parent/reads-plus-join/2026-11-27T15-13-09-139Z_01a21d91-4413-7521-a2bf-0967bc22983b.jsonl#L8) |

These are scripted direct-`/sub` runs; they have no model-dispatched launch turn.

The separate model-dispatched parallel-read run instructed the parent to call `subagent_create` twice in one turn and return the combined answer after the batch follow-up. The parent session has two assistant LLM turns: the first made both launch calls and ended on the terminating tool batch; the second woke once with the two results. The two child sessions and parent transcript are retained under `evidence/rerun/model-dispatched-parallel/` and `evidence/rerun/parent/model-dispatched-parallel-final/`. This directly shows one wake-up for two completions, rather than one per completion. The baseline documentation only quotes that the widget parent used one more model request than the graph parent; it does not give an absolute widget turn count, and the baseline parent transcript was not retained, so the baseline count is **quoted, not measured**, and no numeric before/after delta can be recomputed. Current measured parent turns: **2 total (launch turn + one batch wake-up)**.

The model-dispatched parent transcript directly records lazy tool activation: [line 5](evidence/rerun/parent/model-dispatched-parallel-final/2026-11-27T15-15-17-682Z_01a21d93-3a31-72ce-a3bd-d6fd6badcb99.jsonl#L5) adds only `subagent_create`; [line 10](evidence/rerun/parent/model-dispatched-parallel-final/2026-11-27T15-15-17-682Z_01a21d93-3a31-72ce-a3bd-d6fd6badcb99.jsonl#L10), before the wake-up turn, adds `subagent_continue`, `subagent_remove`, and `subagent_list`. The `subagent_create` schema in the retained transcript is 746 compact-JSON characters, or 187 estimated tokens at `ceil(chars / 4)`; ticket 06's 748-character figure was measured before transcript serialization, and both round to 187 tokens. Keep ticket 06's documented 344 + 272 = 616 estimate split and its caveat that model tokenization and provider framing can differ.

The benchmark parent was started from the log-rotator checkout, with the extension and retained session directory addressed in the ticket worktree:

```sh
WORKTREE=/path/to/feature/subagent-widget-benchmark-rerun
cd /home/deplague/Projects/log-rotator
timeout 240s pi --no-extensions \
  -e "$WORKTREE/subagent-widget.ts" \
  --mode rpc --model openai/gpt-6.1-terra --thinking low \
  --session-dir "$WORKTREE/docs/token-benchmark/evidence/rerun/parent/noop-final"
```

For the other runs, the parent session directory was changed to the matching named directory under `evidence/rerun/parent/`.

The driver used Pi RPC JSONL over stdin/stdout. A scripted launch was sent as `{"id":"rust","type":"prompt","message":"/sub --model openai/gpt-6.1-terra --thinking low <Cargo.toml workload prompt>"}`; the UI launch used the same shape with id `ui`. Pi replied with a correlated `response` whose data had `disposition: "handled"`; the driver waited for the parent `agent_settled` event. The two parallel-read prompts were sent before waiting. For the join workload, the join `/sub` prompt was sent after the reader batch settled. Once child results had settled and their JSONL files were copied, removal was sent as `{"id":"clear","type":"prompt","message":"/subclear"}`. The no-op used `/subrm 1` with the same message shape. The separate model-dispatched run sent a normal user `prompt` JSON record; its text asked the model to make two `subagent_create` calls in the same turn. Its original prompt and tool calls are saved in the model-dispatched parent session.

Before each parent run, the driver recorded the existing filenames in `$HOME/.pi/agent/sessions/subagents/`; after each child finished, it selected the new `subagent-*.jsonl` files by set difference and copied them to the matching `evidence/rerun/<workload>/` directory **before** `/subrm` or `/subclear`. Pi parent sessions were written directly to the evidence directories through `--session-dir`. The four retained parent transcripts document the model-triggered `custom_message` batches and parent usage. No standalone RPC driver script was saved; the parent was driven by a short inline Python `subprocess.Popen` loop using JSON-encoded lines and a stdout event reader.

The child-file collection step was equivalent to:

```python
from pathlib import Path
from shutil import copy2

store = Path.home() / ".pi/agent/sessions/subagents"
evidence_workload_dir = Path("docs/token-benchmark/evidence/rerun/parallel-reads")
before = {p.resolve() for p in store.glob("subagent-*.jsonl")}
# Send the RPC prompts and wait until the workload's child processes settle.
created = [p for p in store.glob("subagent-*.jsonl") if p.resolve() not in before]
for path in created:
    copy2(path, evidence_workload_dir / path.name)  # copy before /subrm or /subclear
```

Runtime inputs and environment: the working directory was `/home/deplague/Projects/log-rotator`; the extension path was the absolute `subagent-widget.ts` in this ticket worktree. The parent inherited its shell environment; the driver set no environment variables. `HOME` selected `~/.pi/agent/auth.json` (OpenAI OAuth; credential contents are not copied), `~/.agents/skills`, and the default child session directory; `PATH` resolved `pi` as `/usr/bin/pi` (Pi 1.6.1). `PI_CODING_AGENT_DIR` was not overridden. Parent Pi used `--no-extensions` plus the explicit worktree extension, but did not use `--no-skills`; the parent therefore loaded the global skills inventory from `~/.agents/skills`. The redacted parent placeholders preserve its original size: 17 entries and 12,007 UTF-8 bytes. Parent tools included the default `read`, `bash`, `edit`, and `write`; these context components contributed to parent usage totals. The child launcher inherited the parent environment and removes `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`, and `SUBAGENT_PI_BINARY`; child arguments disabled skills, MCP, prompt templates, themes, and online startup, and restricted tools to `read,grep,find,ls`. The source inputs were the log-rotator root `AGENTS.md`, `Cargo.toml`, and `ui/AGENTS.md`; the join prompt contained the two reader answers. The extension also imports `themeMap.ts` from its worktree. The parent and child session transcripts identify these prompt and context inputs. The original process environment was inherited rather than snapshotted, so unrelated variable values are unavailable; no secret values are reproduced here.

For each transcript, sum assistant `message.usage.input`, `cacheRead`, `cacheWrite`, `output`, and `cost.total`; `totalTokens` is their token sum and must not be double-counted. This snippet reproduces the measured worker and parent sums, turn counts, and scripted coalescing message counts from the retained evidence:

```python
import glob, json, os

E = "docs/token-benchmark/evidence"
groups = {
    "baseline/no-op workers": [f"{E}/baseline/subagent-1-1795780342925.jsonl"],
    "baseline/parallel-read workers": [
        f"{E}/baseline/subagent-1-1795780122232.jsonl",
        f"{E}/baseline/subagent-2-1795780122234.jsonl",
    ],
    "baseline/read-plus-join workers": [
        f"{E}/baseline/subagent-1-1795780122232.jsonl",
        f"{E}/baseline/subagent-2-1795780122234.jsonl",
        f"{E}/baseline/subagent-3-1795780130007.jsonl",
    ],
    "rerun/no-op workers": glob.glob(f"{E}/rerun/noop/*.jsonl"),
    "rerun/parallel-read workers": glob.glob(f"{E}/rerun/parallel-reads/*.jsonl"),
    "rerun/read-plus-join workers": glob.glob(f"{E}/rerun/reads-plus-join/*.jsonl"),
    "rerun/no-op parent": glob.glob(f"{E}/rerun/parent/noop-final/*.jsonl"),
    "rerun/parallel-read parent": glob.glob(f"{E}/rerun/parent/parallel-reads/*.jsonl"),
    "rerun/read-plus-join parent": glob.glob(f"{E}/rerun/parent/reads-plus-join/*.jsonl"),
    "rerun/model-dispatched parent": glob.glob(
        f"{E}/rerun/parent/model-dispatched-parallel-final/*.jsonl"),
    "rerun/model-dispatched workers": glob.glob(
        f"{E}/rerun/model-dispatched-parallel/*.jsonl"),
}
for name, paths in groups.items():
    sums = {k: 0 for k in ("input", "cacheRead", "cacheWrite", "output", "cost")}
    turns = 0
    for path in paths:
        for line in open(path):
            entry = json.loads(line)
            message = entry.get("message", {})
            if entry.get("type") != "message" or message.get("role") != "assistant":
                continue
            usage = message.get("usage") or {}
            cost = usage.get("cost") or {}
            for key in ("input", "cacheRead", "cacheWrite", "output"):
                sums[key] += usage.get(key, 0)
            sums["cost"] += cost.get("total", 0)
            turns += usage.get("totalTokens", 0) > 0
    print(name, sums, "totalTokens", sum(sums[k] for k in
          ("input", "cacheRead", "cacheWrite", "output")), "LLM turns", turns)
for name, pattern in {
    "scripted parallel-read custom messages": f"{E}/rerun/parent/parallel-reads/*.jsonl",
    "scripted reads-plus-join custom messages": f"{E}/rerun/parent/reads-plus-join/*.jsonl",
}.items():
    count = sum(1 for path in glob.glob(pattern) for line in open(path)
                if json.loads(line).get("type") == "custom_message"
                and json.loads(line).get("customType") == "subagent-result")
    print(name, count)
```

### Evidence redaction

By owner decision, private prompt material in the 17 JSONL transcripts was structurally redacted with [`redact-evidence.py`](redact-evidence.py). The script replaces system-message `skills`, `project_context`, and `rules` sections with placeholders. In JSON entries it traverses, it also replaces non-allowlisted absolute home paths in string values; non-system `message` entries and `custom_message` entries are left intact. A scan found no home path outside the benchmark checkout in the retained evidence. The placeholders preserve original UTF-8 byte lengths and skill entry counts:

- Five baseline transcripts: skills inventory **17 entries / 12,671 bytes**; project context **3,898 bytes**; global rules **232 bytes**.
- Four parent transcripts: skills inventory **17 entries / 12,007 bytes**; project context **3,898 bytes**; global rules **589 bytes**.
- Eight rerun worker transcripts: no skills section; project context **3,898 bytes**; global rules **148 bytes**.

The replaced sections contained the skills inventory and private global rules/project instructions. The evidence keeps benchmark prompts, Cargo.toml and ui/AGENTS.md excerpts, tool calls and results, model IDs, timestamps, and all usage/cost fields. The byte counts are the source sections' pre-redaction UTF-8 lengths; they preserve context-size evidence, not a per-section token allocation. The recorded token and cost fields remain the original provider-reported usage and are unchanged by redaction. The script reserializes JSON, so cost floats use Python exponent notation on 18 lines (for example, `5e-05`); the raw text is not byte-identical to Pi’s output, while parsed numeric values are identical. The README extraction snippet above runs against the redacted files and reproduces those figures. Reproduce the redaction on an original copy with `python3 docs/token-benchmark/redact-evidence.py`.

After redaction, all 17 files parse as JSONL, the script verified that usage snapshots did not change, and a sensitive-string scan (credential prefixes, bearer tokens, email patterns, and removed inventory terms) found no matches. Skill entry blocks and private sections were checked without printing their contents. `bootstrap/README.md` and `bootstrap/HOST.md` were checked and have no stale widget token or cost claims, so neither needed an edit.

## How usage is read

For each Pi session transcript, sum `message.usage.totalTokens` across assistant messages. Pi records `totalTokens` as input plus cache reads, cache writes, and output; reasoning is already included in output. Sum `message.usage.cost.total` for Pi's estimated cost. Sum `input`, `cacheRead`, and `output` separately to distinguish uncached input, cached input, and generated output. Do not add those fields to `totalTokens` a second time. Zero-usage aborted entries stay in the raw transcript but add no tokens.

The run manifest identifies the run, node, and `session_dir`. A readiness record's `session_id` is a Coms ID, not the Pi transcript filename: find the `.jsonl` whose `coms-log` `boot` event has matching `data.session_id`. If needed, match `data.project` to the manifest's `coms_project` and `data.name` to the readiness record's `name`. This snippet sums usage per matched transcript:

```python
import glob, json, os

store = os.path.expanduser("~/.pi/agent/sessions/--home-*-Projects-log-rotator--/*.jsonl")
for manifest_path in glob.glob(os.path.expanduser("~/.pi/agent/bootstrap-sessions/read-only-token-benchmark-*.json")):
    manifest = json.load(open(manifest_path))
    for ready_path in glob.glob(manifest["session_dir"] + "/*.ready.json"):
        ready = json.load(open(ready_path))
        for path in glob.glob(store):
            events = [json.loads(line) for line in open(path)]
            boot = next((e["data"] for e in events
                         if e.get("type") == "custom" and e.get("customType") == "coms-log"
                         and e["data"].get("event") == "boot"), {})
            matches = (boot.get("session_id") == ready["session_id"] or
                       (boot.get("project") == manifest["coms_project"]
                        and boot.get("name") == ready["name"]))
            if not matches:
                continue
            messages = [e["message"] for e in events
                        if e.get("type") == "message" and e["message"].get("role") == "assistant"]
            print(os.path.basename(path),
                  sum((m.get("usage") or {}).get("totalTokens", 0) for m in messages),
                  sum(((m.get("usage") or {}).get("cost") or {}).get("total", 0) for m in messages))
            break
```

For graph agent totals, sum node transcripts and exclude the dispatcher. For widget end-to-end totals, sum both widget agent transcripts and the parent transcript. The model-dispatched row likewise counts both agents and parent. The earlier cost calculation used $1 per million uncached input tokens, $0.05 per million cached input tokens, and $5 per million output tokens; rates can change and are only a comparison estimate.

## Follow-up optimizations

1. **Stable prompt prefix and tool-schema ordering for cache hits.** The model-dispatched read comparison showed a 66.3% (quoted) graph cache share versus 83.4% (quoted) for the widget, 15.3k (quoted) versus 8.1k (quoted) uncached input tokens, and $0.019461 (quoted) versus $0.011662 (quoted) estimated cost despite fewer graph total tokens. Keep shared instructions and tool schemas stable at the front, then move run-specific IDs and handoff details later. Measure cache reads, cache share, uncached input, total tokens, and estimated cost in repeated matched runs before and after. Adopt a prompt-layout change only if the repeated measurements improve cache share and reduce uncached input and cost while preserving correct results and handoffs; otherwise keep the existing layout.

2. **Command nodes for deterministic extraction, validation, and merging.** The benchmark's file-field extraction and fixed `|` join have deterministic outputs and do not require model judgment. Prototype command nodes for such steps and compare exact outputs, handoff evidence, end-to-end latency, and agent model tokens with the equivalent graph. Use a command node when it produces the same validated output and lowers end-to-end model usage without changing the run's dependencies or handoff behavior. Keep agent nodes for tasks that require judgment.

## Subagent management tool schemas (ticket 06)

With zero subagents, the payload falls from **803 estimated tokens** with the old descriptions and all four tools active to **187 estimated tokens** with the shortened create schema active, a combined saving of **616 estimated input tokens per parent turn**. The split is **344 tokens** from shorter descriptions (803 to 459 with all four tools active), plus **272 tokens** from deactivating the three management tools (459 to 187). The activation saving exceeds the ticket's ~150-token threshold, so lazy activation is kept. The model's actual tokenizer and provider-side schema framing can change the exact token count; these figures are estimates, not reported usage.

Method: serialize the active tool definitions as compact JSON objects containing only `name`, `description`, and `parameters`, then estimate tokens as `ceil(JSON character count / 4)`. The definitions were obtained from the extension entry point using `createFakeHost` in `subagent-widget.test-helpers.ts`. The harness serializes enum descriptions and values, and the measurement normalizes its TypeBox-shaped declarations into JSON Schema, including `required` properties while omitting the stub's `optional` marker. The pre-change side used source at baseline commit `4e00b6d108fe9c6e3dc4cbc8b2c64ea9b284a9eb` and all four registered tools active; the post-change side used this ticket's source and the harness's default active set. `defaultActive`, executors, and inactive tool definitions are excluded from the serialized request payload.

| State | Active schemas | Serialized characters | Estimated tokens |
|---|---|---:|---:|
| Before ticket 06, old descriptions | create, continue, remove, list | 3,210 | 803 |
| After ticket 06, shortened descriptions | create, continue, remove, list | 1,833 | 459 |
| After ticket 06, zero subagents | create | 748 | 187 |
| Description saving | All four schemas shortened | 1,377 | 344 |
| Activation saving | Continue, remove, list omitted | 1,085 | 272 |
| Combined saving | Shorter descriptions and lazy activation | 2,462 | 616 |

To reproduce, load the baseline source from the commit above and the current extension through `loadSubagentWidget()` / `createFakeHost()`. Convert each tool's TypeBox-shaped schema into JSON Schema: retain `type`, `description`, `enum`, `items`, and recursively converted `properties`; for objects, include `required` with property names whose schemas are not marked optional. Serialize `host.tools` entries whose names are in `host.getActiveTools()` using `JSON.stringify({ name, description, parameters })`. Divide each serialized length by four and round up. For the shortened-description/all-four-tools row, add the three management names to the current harness active set before serializing; the zero-subagent row uses its default active set. The current test harness models Pi's default activation: tools are active on registration unless `defaultActive: false`.

## Documentation check

`bootstrap/README.md` and `bootstrap/HOST.md` were checked. Their completion descriptions already cover successful terminating results, retries that find delivery settled, and the refusal or delivery cases that keep the turn open. No stale token or cost claim was found, so neither file needed an edit.
