# Bootstrap orchestration implementation specification

Status: implementation plan draft; grilling recommendations accepted by the user. Prepared 2026-11-17. No implementation or external issue publication is authorized by this document. Prototypes are explicitly excluded.

## Problem Statement

The extension launches teams and chains reliably in many normal cases, but its execution contract is underspecified around peer collaboration, partial results, handoff acceptance, workspace ownership and recovery. A team member is currently a short-lived task worker even though Coms permits conversational follow-ups. A chain depends on model-triggered delivery and transport acknowledgements that do not prove task acceptance. Shared project directories allow concurrent edits without an integration contract.

The code is actively changing. This specification supersedes earlier suggestions that described preview, shared briefs, status waiting, canonical fingerprints, reservation publication, locking and reconciliation as wholly missing. Their presence is not proof of correctness: the first milestone verifies and completes the current implementations.

## Solution

Ship a hardened team/chain core first. It gives each assignment an identity independent of its persona, explicit execution outcomes and verification evidence, validated inputs, durable acceptance evidence, safe delivery recovery, cancellation and clear shared-directory ownership. Preserve familiar tools and legacy run inspection. Richer preview, optional synthesis and expanded /boot commands are follow-on improvements, not first-release blockers.

Add isolated implementation workspaces, bounded collaboration and graph scheduling as separately selectable capabilities. Keep ordinary teams and chains simple. Introduce a supervisor only when lazy/unattended scheduling actually requires a durable runtime owner.

## User Stories

1. As a dispatcher, I can use the same persona for several distinct assignments.
2. As a worker, I understand the run goal, my responsibility and the relevant peer responsibilities.
3. As a dispatcher, I can preview the exact resolved plan and detect changes before launch.
4. As a dispatcher, I know which checks were verified locally and which require child startup.
5. As a chain author, I choose whether partial upstream output is acceptable.
6. As a worker, I can retrieve the necessary earlier decisions without receiving unbounded context.
7. As a successor, I reject missing or invalid required input before model work.
8. As a dispatcher, I distinguish message queueing, input acceptance, execution and completion.
9. As an operator, I can retry a notification without repeating completed side effects.
10. As an operator, I see claimed-but-unfinished work as uncertain and can inspect it before acting.
11. As a dispatcher, I distinguish a task that failed from one that never ran.
12. As a user, I can cancel work without deleting its results or immediately closing its tab.
13. As a dispatcher, I can impose execution deadlines independently of liveness checks.
14. As a team member, I know which files or responsibilities I own.
15. As a team author, I can select independent execution without unsolicited peer task activation.
16. As a dispatcher, I can keep healthy independent members running after another member fails.
17. As a dispatcher, I can request a synthesis of member findings with a defined missing-result policy.
18. As a user, I can find and inspect runs from a new dispatcher session.
19. As an operator, I can inspect healthy members even when another member's state is corrupt.
20. As a maintainer, I can verify runtime behavior without touching user trust/configuration or paid providers.
21. As a user, my workers use the existing project directory by default, and separate worktrees are created only when I explicitly request them.
22. As an integrator, I can combine changes in a dedicated workspace and expose conflicts.
23. As a reviewer, I can distinguish individual success from combined verification success.
24. As a collaborator, I can ask a bounded question without changing a peer's assignment.
25. As a collaborator, I can consult an early finisher during an explicit availability lease.
26. As a workflow author, I can express parallel branches and joins.
27. As a dispatcher, I can bound active work and understand why a node is queued.
28. As a user, I can opt into a run that continues scheduling after the dispatcher exits.
29. As a user, I can opt into lazy launch and understand its weaker upfront readiness guarantee.
30. As a workflow author, I can request a bounded revision with preserved previous evidence.
31. As an operator, I can archive runs without losing idempotency or deleting uncertain work.
32. As an existing user, I can still inspect, report and clean up older runs safely.

## Implementation Decisions

### Vocabulary and identities

A run is the complete invocation; its existing public task_id remains supported. A node is a planned assignment. A persona is a reusable configuration. An attempt is one execution of a node. A worker is the live process/session executing an attempt. An artifact is referenced output with provenance. A handoff is immutable input transfer plus its acceptance evidence.

Do not conflate persona names with unique node IDs or worker sessions. New records carry explicit protocol versions and validate at read boundaries. Unsupported versions fail clearly while preserving safe ownership evidence for operator recovery.

### Modules and test seams

Keep extension registration and presentation thin. The orchestration module owns plan normalization, policies, status and recovery; worker hooks enforce admission and completion; durable storage owns validated records, atomic publication and ownership locks; messaging provides notifications; workspace operations own external resource creation and integration.

Prefer the existing BootstrapService executor seam and worker-hook harness. Add a narrow messaging seam only for typed peer coordination, and a workspace seam when worktrees introduce real external behavior. The optional supervisor is a runtime owner using the same orchestration operations, not a second scheduler implementation. Avoid a broad framework refactor before user-visible slices.

### Execution state

Keep resource state, execution state, result outcome and delivery state separate. Resource closure cannot erase execution history. A saved successful result does not prove delivery; a transport acknowledgement does not prove admission; a heartbeat does not prove useful progress.

Dependency policy defaults to require_success for new-format plans. Legacy plans retain existing allow_partial behavior. Blocked descendants carry the original cause; they are not reported as failed executions. Terminal blocked/skipped/cancelled nodes can be included in a complete report without fabricated worker results. needs_attention is unresolved and prevents dependent admission.

Separate the worker's reported outcome from verification evidence. A model-reported success alone does not establish that required checks passed or required artifacts exist. When a dependency requires declared checks, admission requires passing, current evidence as well as the applicable outcome policy. Unverified or stale evidence cannot silently satisfy that requirement.

### Durable handoff and recovery

The source commits its immutable result first. A destination validates the run, source/destination attempts, input digest and dependency policy, then atomically claims the handoff before side effects. Acceptance is durable and externally observable. Repeated notifications reference the same logical handoff.

Coms remains useful for waking workers, but its ACK is not execution authority. The dispatcher may repair demonstrably unclaimed delivery from saved evidence without a new user confirmation. Claimed work without a result is never automatically replayed. Before a new attempt with uncertain prior effects, require an explicit decision and retain prior evidence; absence of a receipt alone is insufficient if other evidence indicates execution. No exactly-once side-effect guarantee is promised.

### Inputs and outputs

Shared brief and roster are bounded, structured context. Upstream content is data, distinct from the worker's task instructions. Required output contracts are validated before dependent admission. Artifact references include producer/attempt identity and hashes where applicable; larger data is fetched explicitly. A worker needing a referenced file must have an appropriate retrieval mechanism before release.

Verification records identify the check, result, attempt and relevant repository state. In shared cwd, a commit ID alone is insufficient: capture relevant working-tree content, including relevant untracked inputs, before and after the check. Changes during the check invalidate its applicability; subsequent relevant changes mark the evidence stale at inspection or dependency admission. If relevance cannot be determined, use a conservative scope or report applicability as unknown. Keep historical evidence intact and require a fresh check where current evidence is necessary. This does not create a worktree or promise a filesystem snapshot.

### Team policies

New plans default to independent assignments; collaborative behavior requires explicit opt-in. Legacy plans preserve existing messaging semantics until intentionally migrated. Independent mode allows internal lifecycle coordination while rejecting peer-created assignments. Ownership scopes are visible at preview and launch. Allow parallel tasks with disjoint declared write scopes; serialize known overlapping writes in deterministic plan order. Hold a conflicting scope when a previous writer's execution is uncertain rather than treating a missing heartbeat as release. Ownership is advisory outside bootstrap scheduling unless separately enforced, and never authorizes automatic worktree creation.

Collaborative mode adds typed, correlated asynchronous questions and answers with membership checks and bounds. Consultation cannot revise task authority or mutate completed results. Completion and worker availability are separate; keepalive leases and consultation budgets are explicit.

### Workspace strategy

The existing project cwd is the default for every topology, including implementation teams, graphs and revision attempts. Worktree creation requires an explicit user request, represented by git-worktree strategy in the run plan. Omitting the strategy selects shared cwd. A dispatcher must not infer this request from parallel work, overlapping ownership, a dirty repository, or a recommendation to isolate edits. Such conditions may produce diagnostics but never switch the strategy automatically. Preview shows the effective strategy without creating worktrees.

When explicitly requested, git-worktree mode isolates repository edits using a recorded clean base and leaves uncommitted user work untouched. Initial support does not invent a snapshot of dirty user changes. Validate Git availability and the clean-base requirement only for requested worktree creation; shared mode must remain usable in non-Git or dirty projects. Persist the requested scope so recovery cannot expand it. If requested worktree creation fails, report the failure rather than silently falling back to shared cwd.

Integration of explicitly isolated outputs uses a requested integration workspace with deterministic input order, preserved progress and explicit conflict reporting. Any additional integration worktree must be included in the user's requested scope; selecting synthesis, verification or revision does not authorize its creation. Shared-cwd workflows verify changes in the existing project directory and do not require worktree integration. Synthesis summarizes evidence; integration combines code; verification checks the result. None implies authorization to merge into the user's branch or publish.

### Scheduling

Core keeps the existing all-workers-ready barrier. Optional graph mode initially prelaunches workers and gates execution on dependencies. Durable admission slots bound active tasks but do not claim to bound prelaunched process count.

Lazy launch requires an explicit run-scoped supervisor that survives dispatcher exit, owns a lease, reconciles external actions and can be restarted. It is opt-in and not a permanent daemon by default. Lazy launch validates the plan upfront but cannot promise every future worker will start; downstream startup failures preserve earlier work and surface clearly.

Revisions create new attempts and expand an acyclic workflow with finite limits. They run in the existing project cwd by default and preserve the explicitly selected workspace strategy. They do not require worktree support, automatically create worktrees, or enable unrestricted self-directed loops.

### Cancellation and deadlines

Persist cancellation intent before signalling. Deny new admission afterward, preserve already committed results and expose running effects that could not be interrupted. Define completion/cancellation races by durable evidence. Tab closing, session-file deletion and workspace deletion remain separate resource operations.

Set explicit task-duration and dependency-wait policies. Use liveness only for diagnosis. Existing timeout values stay compatible for legacy requests. New defaults should be documented and tested rather than silently changing long-running workflow behavior.

### Compatibility and rollout

Introduce new schema versions alongside old readers. Preserve legacy input forms and v1 inspection/report/cleanup; do not migrate live runs by rewriting their identities. New capabilities require new-format plans. Keep reservation version handling explicit so old request IDs cannot create duplicate runs after upgrade or archive.

Ship core first, optional features disabled until tested. A previous binary should reject unsupported new records rather than misinterpret them. Publish migration and recovery guidance before enabling new behavior by default.

### Trust and durability

Bootstrap workers run under the same user and often share a filesystem. Run tokens, identity checks and hashes protect protocol correctness and accidental cross-run confusion; they do not isolate malicious same-user processes. Preserve normal policy/sandbox hooks and private state paths.

Validate persisted inputs and constrain managed paths. Handle corruption per record where safe, while failing closed for execution and destructive operations with uncertain ownership. Document process-crash guarantees separately from power-loss guarantees. Stronger fsync-based guarantees are a deliberate storage choice, not an implied property of atomic rename.

## Testing Decisions

Test observable contracts through the existing orchestration executor and worker hook seams. Keep parser tests focused; avoid tests that merely repeat state-machine internals. Use fake time for deadlines and leases, real temporary files for persistence, real subprocesses for competing owners, and the isolated installed Pi runtime for hook ordering and schema compatibility.

Every ticket includes its own failure tests and documentation update; release tickets validate composition rather than postponing all testing. No real-provider requests in automated suites. Live Herdr tab lifecycle verification is opt-in and records what was actually tested.

The user explicitly declined prototypes. Do not create throwaway demos, experimental branches or exploratory runtime spikes. Normal implementation regression tests, isolated runtime integration tests and release checks remain required; incorporate runtime ordering and race cases there without adding a prototype prerequisite.

### Core acceptance matrix

| Scenario | Required evidence |
| --- | --- |
| Two nodes using one persona | Separate input, output, identity and cleanup selection |
| Successful chain | Accepted input precedes each start; ordered durable results |
| Partial predecessor | require_success blocks; allow_partial continues |
| Failed predecessor | Descendants do not run; original cause remains visible |
| Queue ACK but rejected handoff | No false accepted/running status; recovery guidance |
| Duplicate notification | No second task execution for the same attempt |
| Crash after claim | needs_attention; no automatic replay |
| Cancel during execution | New admission stops; evidence and unaffected work remain |
| Independent team failure | Healthy members continue unless fail-fast selected |
| Shared-directory writers | Disjoint scopes can overlap in time; known conflicting writers are serialized |
| Verification during or after relevant edits | Historical result retained; stale evidence does not satisfy required checks |
| Concurrent dispatcher/recovery | One owner; no duplicate fleet or lost updates |
| Initialized session replacement | Ordinary new session receives no old task authority |
| Mixed terminal outcomes | Useful final report, correct aggregation and provenance |
| Legacy run | Inspect/report/cleanup still work safely |

### Advanced acceptance matrix

| Scenario | Required evidence |
| --- | --- |
| Optional synthesis with missing member | Declared policy determines run/block/summary |
| Workspace strategy omitted or shared | Existing cwd; zero worktree creation across launch, recovery and revision |
| Explicitly requested isolated parallel edits | Worktrees only within requested scope; explicit integration conflict |
| Combined build fails | Individual and integrated outcomes remain distinct |
| Mutual peer questions | No protocol deadlock; bounded asynchronous correlation |
| Early collaborator finishes | Can consult until lease expiry without reopening result |
| Diamond graph | Join consumes all required accepted inputs exactly once per attempt |
| Capacity-limited graph | No model work without a durable admission slot |
| Dispatcher disappears | Supervisor continues or clearly pauses according to policy |
| Lazy downstream startup fails | Upstream evidence retained; no false rollback |
| Revision limit exhausted | Stops with prior attempts intact |
| Archive and request retry | Tombstone prevents duplicate execution |

## Out of Scope

Remote workers or distributed multi-host scheduling; hostile-agent isolation; arbitrary shell/filesystem rollback; exactly-once external side effects; unrestricted recursive delegation; automatic publication/merge; broad replacement of Coms; support for every VCS; an always-on global daemon; billing guarantees where the runtime has no usage data.

## Further Notes

This is a local draft, not a set of published or approved external issues. No configured tracker was found. If external tracker publication is wanted, run /engineering setup-matt-pocock-skills to configure it first.

Confirmed user decision: worktrees are optional and created only on explicit request. Shared cwd is the default; worktree support is not a prerequisite for revision workflows or the non-worktree release gates.

Accepted grilling decisions: parallel disjoint writers with serialization for known overlapping writes; independent teams by default and explicit collaboration; separate worker claims from verification evidence; require successful predecessors by default for new chains with explicit per-dependency partial allowance; dispatcher repair of demonstrably unclaimed delivery with an explicit decision for uncertain re-execution; a first release focused on the core execution contract. Track verification freshness against relevant repository state. No prototypes.

The existing service and worker-hook test seams remain the implementation starting point, supplemented by normal isolated runtime tests. These accepted choices do not require another confirmation before updating the plan.

No calendar estimate is claimed. Core is the first shipping scope. Optional tracks can be deferred independently, with graph/lazy scheduling last because they add a new runtime lifecycle.
