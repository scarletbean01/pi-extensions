# Read-only token benchmark

This note records the pre-ticket-01 Bootstrap baseline and one post-ticket-01 rerun of each graph workload. The rerun uses the installed extensions, which include commit `91bf201`. Baseline manifests were created from 09:26–09:29Z, before `ccb44d6` (09:59Z) and the `91bf201` merge (10:15Z); rerun manifests were created from 10:27–10:28Z. All workloads were read-only and used `openai/gpt-6.1-terra` with low thinking.

## Setup and prompts

The benchmark compared a fresh `subagent-widget.ts` agent with Bootstrap graph nodes. Runs used Pi 1.6.1, `hc` 0.1.22, and the `/home/deplague/Projects/log-rotator` checkout. Graph runs used `topology: "graph"`, `task: "Read-only token benchmark"`, `goal: "Return short exact answers for a matched token trial."`, `constraints: ["Do not edit project files."]`, `cleanup: "manual"`, and `task_timeout_ms: 60000`. Each graph node used persona `scout`; its `terra` alias resolved to `openai/gpt-6.1-terra`, thinking `low`. The persona enabled `read`, `grep`, `find`, `ls`, and `bash`, with an empty skills list. Bootstrap and Coms added their runtime tools. The original harness set `request_id` to `token-bench-<trial ID>`; the post-change rerun used fresh idempotency keys so it could not reuse a baseline run. `request_id` does not change the node prompt.

The widget created a fresh Pi session per node through `/sub`. It had the same model and thinking level, five read-only built-in tools, no extensions, and the default skill descriptions. The widget reported each result to the parent as a model-triggering follow-up. These are not identical system prompts: the widget session included a 12,671-byte skills section (quoted; not verifiable from retained files), while `scout` had no skills.

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

The `read-only-token-benchmark-*.json` glob in `/home/deplague/.pi/agent/bootstrap-sessions/` matches 16 files: the 13 baseline IDs listed here and the three rerun IDs listed below. Their `session_dir` points to each run's immutable node inputs, readiness records, results, and manifest under the `log-rotator` checkout. The node `.input.json` files preserve each graph prompt; `.ready.json` records the resolved model and Coms session ID. The Pi session transcript for an agent is in the project session store, `/home/deplague/.pi/agent/sessions/--home-deplague-Projects-log-rotator--/`.

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

## How usage is read

For each Pi session transcript, sum `message.usage.totalTokens` across assistant messages. Pi records `totalTokens` as input plus cache reads, cache writes, and output; reasoning is already included in output. Sum `message.usage.cost.total` for Pi's estimated cost. Sum `input`, `cacheRead`, and `output` separately to distinguish uncached input, cached input, and generated output. Do not add those fields to `totalTokens` a second time. Zero-usage aborted entries stay in the raw transcript but add no tokens.

The run manifest identifies the run, node, and `session_dir`. A readiness record's `session_id` is a Coms ID, not the Pi transcript filename: find the `.jsonl` whose `coms-log` `boot` event has matching `data.session_id`. If needed, match `data.project` to the manifest's `coms_project` and `data.name` to the readiness record's `name`. This snippet sums usage per matched transcript:

```python
import glob, json, os

store = "/home/deplague/.pi/agent/sessions/--home-deplague-Projects-log-rotator--/*.jsonl"
for manifest_path in glob.glob("/home/deplague/.pi/agent/bootstrap-sessions/read-only-token-benchmark-*.json"):
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

With zero subagents, the registered tool payload shrinks from **803 estimated tokens** (create, continue, remove, list) to **183 estimated tokens** (create only), a saving of **620 estimated input tokens per parent turn**. This exceeds the ticket's ~150-token threshold, so lazy activation is kept. The model's actual tokenizer and provider-side schema framing can change the exact token count; these figures are estimates, not reported usage.

Method: serialize the active tool definitions as compact JSON objects containing only `name`, `description`, and `parameters`, then estimate tokens as `ceil(JSON character count / 4)`. The definitions were obtained from the extension entry point using `createFakeHost` in `subagent-widget.test-helpers.ts`. The harness serializes enum descriptions and values, and the measurement normalizes its TypeBox-shaped declarations into JSON Schema, including `required` properties while omitting the stub's `optional` marker. The pre-change side used source at baseline commit `4e00b6d108fe9c6e3dc4cbc8b2c64ea9b284a9eb` and all four registered tools active; the post-change side used this ticket's source and the harness's default active set. `defaultActive`, executors, and inactive tool definitions are excluded from the serialized request payload.

| State | Active schemas | Serialized characters | Estimated tokens |
|---|---|---:|---:|
| Before ticket 06, zero subagents | create, continue, remove, list | 3,210 | 803 |
| After ticket 06, zero subagents | create | 731 | 183 |
| Difference | continue, remove, list omitted | 2,479 | 620 |

To reproduce, load the baseline source from the commit above and the current extension through `loadSubagentWidget()` / `createFakeHost()`. Convert each tool's TypeBox-shaped schema into JSON Schema: retain `type`, `description`, `enum`, `items`, and recursively converted `properties`; for objects, include `required` with property names whose schemas are not marked optional. Serialize `host.tools` entries whose names are in `host.getActiveTools()` using `JSON.stringify({ name, description, parameters })`. Divide each serialized length by four and round up. The current test harness models Pi's default activation: tools are active on registration unless `defaultActive: false`.

## Documentation check

`bootstrap/README.md` and `bootstrap/HOST.md` were checked. Their completion descriptions already cover successful terminating results, retries that find delivery settled, and the refusal or delivery cases that keep the turn open. No stale token or cost claim was found, so neither file needed an edit.
