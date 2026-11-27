# Read-only token benchmark

This note records the pre-ticket-01 Bootstrap baseline and one post-ticket-01 rerun of each graph workload. The rerun uses the installed extensions, which include commit `91bf201`. All workloads were read-only and used `openai/gpt-6.1-terra` with low thinking.

## Setup and prompts

The benchmark compared a fresh `subagent-widget.ts` agent with Bootstrap graph nodes. Runs used Pi 1.6.1, `hc` 0.1.22, and the `/home/deplague/Projects/log-rotator` checkout. Graph runs used `topology: "graph"`, `task: "Read-only token benchmark"`, `goal: "Return short exact answers for a matched token trial."`, `constraints: ["Do not edit project files."]`, `cleanup: "manual"`, and `task_timeout_ms: 60000`. Each graph node used persona `scout`; its `terra` alias resolved to `openai/gpt-6.1-terra`, thinking `low`. The persona enabled `read`, `grep`, `find`, `ls`, and `bash`, with an empty skills list. Bootstrap and Coms added their runtime tools. The original harness set `request_id` to `token-bench-<trial ID>`; the post-change rerun used fresh idempotency keys so it could not reuse a baseline run. `request_id` does not change the node prompt.

The widget created a fresh Pi session per node through `/sub`. It had the same model and thinking level, five read-only built-in tools, no extensions, and the default skill descriptions. The widget reported each result to the parent as a model-triggering follow-up. These are not identical system prompts: the widget session included a 12,671-byte skills section, while `scout` had no skills.

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

The 13 pre-change manifests are named `read-only-token-benchmark-*.json` in `/home/deplague/.pi/agent/bootstrap-sessions/`. Their `session_dir` points to each run's immutable node inputs, readiness records, results, and manifest under the `log-rotator` checkout. The node `.input.json` files preserve each graph prompt; `.ready.json` records the resolved model and Coms session ID. The Pi session transcript for an agent is in the project session store, `/home/deplague/.pi/agent/sessions/--home-deplague-Projects-log-rotator--/`.

The 13 manifests comprise three scored scripted no-op runs, three scripted parallel-read runs, three join runs, three model-dispatched parallel-read graph runs, and one earlier no-op shakedown. Their task ID suffixes are: scored no-op `4360d378`, `ca371100`, `df2eefd9`; scripted reads `ef98575a`, `e29a64b4`, `aed3b6c6`; model-dispatched graph reads `bc82d887`, `b49c6fb0`, `b9737abe`; joins `84b70ebe`, `377cbdb0`, `76a803b7`; excluded shakedown `4c3e1753`. Each full ID starts with `read-only-token-benchmark-`. The shakedown is excluded from the scripted medians. The baseline figures below are the median of three scored scripted graph runs; ranges are included to show their spread. The no-ack column is an estimate recomputed from those transcripts by removing each node's final stopping response, which acknowledged `bootstrap_complete` after its result had been saved.

| Workload | Pre-change graph tokens, median (range) | Without final acknowledgments, estimated | Post-change graph tokens, one run | Saved vs. pre-change median | Difference from estimate | Post-change Pi cost estimate |
|---|---:|---:|---:|---:|---:|---:|
| One no-op node | 7,526 (7,518–7,530) | 3,750 | 3,765 | 3,761 | +15 | $0.003929 |
| Two parallel reads | 23,933 (23,915–23,987) | 15,838 | 15,918 | 8,015 | +80 | $0.0092956 |
| Two reads plus a join | 34,319 (34,225–34,447) | 21,082 | 21,190 | 13,129 | +108 | $0.014634 |

The post-change runs used the same graph topology, node IDs, task prompts, read paths, dependencies, persona, and model. Each was one launch; all nodes succeeded, each graph report was collected, and each run was cleaned up with its session files retained. The run IDs are:

- No-op: `read-only-token-benchmark-69ff937e-c477-473d-8014-14676e59570f`
- Parallel reads: `read-only-token-benchmark-57f7f4a9-2a04-44b7-9760-a3927585bc70`
- Reads plus join: `read-only-token-benchmark-2c947f8c-463f-429d-bbaf-46e2e1acd420`

The no-op and parallel-read transcripts ended on the terminating `bootstrap_complete` call, without a subsequent acknowledgment response. The join's wait for its second inbound handoff left a zero-usage aborted transcript entry; it made no extra model request and does not contribute tokens. Post-change agent totals exclude the dispatcher model calls used to plan, report, and clean up these runs.

## Widget comparison

The scripted widget and graph comparison below is from three matched repeats per workload. Widget parent usage is included in its total because the widget delivered model-triggering follow-ups; the scripted graph parent made no model calls. Graph agent totals are recomputed from the retained Bootstrap sessions. Widget and parent values are quoted from the earlier benchmark record because the 13 Bootstrap manifests do not contain those transcripts.

| Scripted workload | Widget agents | Widget parent | Widget total | Graph agents | Graph parent | Graph total | Graph total difference |
|---|---:|---:|---:|---:|---:|---:|---:|
| No-op | 5,204 | 1,502 | 6,706 | 7,526 | 0 | 7,526 | +12.2% |
| Parallel reads | 21,131 | 3,146 | 24,277 | 23,933 | 0 | 23,933 | −1.4% |
| Reads plus join | 26,381 | 4,912 | 31,293 | 34,319 | 0 | 34,319 | +9.7% |

The separate model-dispatched comparison covers parallel reads and parent synthesis. Its end-to-end figures are quoted from the earlier analysis: the graph used 6.6% fewer total tokens but had 67% higher Pi-estimated cost. The graph agent median of 23,961 tokens is recomputed from its three `e075652a1b` graph sessions; the graph parent and widget ledgers are not in the retained Bootstrap manifest set. The uncached/cached/output values are per-workflow means across three repeats, and cache share is pooled across those repeats against input-side tokens.

| Model-dispatched parallel reads | Widget | Graph |
|---|---:|---:|
| Agent tokens | 21,135 | 23,961 |
| Parent tokens | 28,045 | 21,953 |
| Total tokens | 49,180 | 45,914 |
| Uncached input / cached input / output | 8,133 / 40,747 / 298 | 15,299 / 30,080 / 532 |
| Cache share of input | 83.4% | 66.3% |
| Pi-estimated cost | $0.011662 | $0.019461 |

The widget's parent used one more model request than the graph parent in this dispatch case, which offset the graph's higher agent token count. Costs use Pi's model registry rates and are estimates, not provider invoices.

## How usage is read

For each Pi session transcript, sum `message.usage.totalTokens` across assistant messages. Pi records `totalTokens` as input plus cache reads, cache writes, and output; reasoning is already included in output. Sum `message.usage.cost.total` for Pi's estimated cost. Sum `input`, `cacheRead`, and `output` separately to distinguish uncached input, cached input, and generated output. Do not add those fields to `totalTokens` a second time. Zero-usage aborted entries stay in the raw transcript but add no tokens.

The run manifest identifies the run, node, and `session_dir`; the node readiness record maps its Coms session ID to its Pi transcript. For graph agent totals, sum node transcripts and exclude the dispatcher. For widget end-to-end totals, sum both widget agent transcripts and the parent transcript. The model-dispatched row likewise counts both agents and parent. The earlier cost calculation used $1 per million uncached input tokens, $0.05 per million cached input tokens, and $5 per million output tokens; rates can change and are only a comparison estimate.

## Follow-up optimizations

1. **Stable prompt prefix and tool-schema ordering for cache hits.** The model-dispatched read comparison showed a 66.3% graph cache share versus 83.4% for the widget, 15.3k versus 8.1k uncached input tokens, and $0.019461 versus $0.011662 estimated cost despite fewer graph total tokens. Keep shared instructions and tool schemas stable at the front, then move run-specific IDs and handoff details later. Measure cache reads, cache share, uncached input, total tokens, and estimated cost in repeated matched runs before and after. Adopt a prompt-layout change only if the repeated measurements improve cache share and reduce uncached input and cost while preserving correct results and handoffs; otherwise keep the existing layout.

2. **Command nodes for deterministic extraction, validation, and merging.** The benchmark's file-field extraction and fixed `|` join have deterministic outputs and do not require model judgment. Prototype command nodes for such steps and compare exact outputs, handoff evidence, end-to-end latency, and agent model tokens with the equivalent graph. Use a command node when it produces the same validated output and lowers end-to-end model usage without changing the run's dependencies or handoff behavior. Keep agent nodes for tasks that require judgment.

## Documentation check

`bootstrap/README.md` and `bootstrap/HOST.md` were checked. Their completion descriptions already cover successful terminating results, retries that find delivery settled, and the refusal or delivery cases that keep the turn open. No stale token or cost claim was found, so neither file needed an edit.
