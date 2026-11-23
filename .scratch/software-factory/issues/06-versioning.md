# Define factory definition changes

Type: grilling
Status: resolved
Assignee: deplague
Blocked by: 02

## Question

How are factory definitions changed and identified, and which definition applies to an input accepted before a change but still queued when it takes effect? Ensure active runs retain a stable definition; consider validation, visibility and removal of old definitions.

## Answer

- **Publish explicitly.** The operator publishes from the managing Pi session. Validate the exact resolved definition to be stored, without launching agents: check the graph, contracts, limits and dependencies that can be checked statically, including whether the attempt budget covers every node's first attempt. A failed publication leaves the current version unchanged. Editing source files, stopping, or resuming does not publish. The operator need not drain the queue to publish, and publication never resumes a stopped factory.
- **Separate factory identity from definition version.** A factory keeps its stable ID; successful publications receive increasing per-factory version numbers (`v1`, `v2`, …). A version becomes current only once its immutable definition is durably stored. Show the current version in factory status, and the bound version on input receipts, queue entries, run status and reports.
- **Bind at durable acceptance.** An input records the version that is current at its acceptance, even if it cannot launch yet. If publication and acceptance overlap, the durable ordering determines which version is bound. Retries by submission reference return the original receipt and version. New publications never change queued inputs or active runs. To move a brief whose launch has not begun, explicitly discard its input and submit a replacement using a new submission reference.
- **Freeze the definition, not the environment.** Preserve the target checkout, graph, node instructions and contracts, intervention rules, resolved limits, persona prompts, resolved models and thinking levels, and declared tool, skill and extension settings. Launch from the preserved version, not by re-resolving the original draft, persona names, aliases or defaults. This does not snapshot the checkout contents, Pi, credentials, or installed skill or extension contents. A policy that inherits Pi's tool or skill defaults still inherits what is available at launch; distinguish inherited settings in status.
- **Do not silently substitute at launch.** Check the bound version's integrity and compatibility with current runtime prerequisites and operator limits. If an unavailable dependency, stricter limit or damaged version is detected before launch begins, show the head input as blocked with a reason. Do not skip it, change its definition, swap a model, or silently clamp limits. Problems discovered after launch begins follow normal launch and recovery rules.
- **Keep old versions.** The initial release has no per-version deletion or revocation. Supersession does not disable queued work. If an old version should no longer run, stop the factory, explicitly discard affected inputs that have not begun launch, and use run controls for active runs. To restore an older definition for future inputs, validate and publish a copy of the preserved definition as a new version; do not rewind history or reconstruct it from draft files.

## Evidence

- [Bootstrap preview and launch](../../../bootstrap/lifecycle.ts#L850) resolve the request separately. The attempt-budget floor is enforced by launch, not by dry run.
- [Bootstrap's agent protocol](../../../bootstrap/README.md#agent-protocol) already preserves the persona prompt for a run; [worker startup](../../../bootstrap/worker.ts#L1082) checks live availability of tools and the expected model. Neither is a reusable factory definition snapshot.

## Boundaries for later decisions

- [Define durability and recovery guarantees](07-recovery.md) owns interruption handling for publication and acceptance, and recovery when launch may already have begun.
- [Define factory operation and visibility](08-observability.md) owns how operators see version information, validation failures and version-related queue blocks in Pi/Herdr.
