# 04: Publish changes without rebinding accepted work

**What to build:** A graph author can publish a new factory definition without draining the queue or changing running work. A submitter can see exactly which definition each input will use and why it might be blocked. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [03: Launch the first input safely](03-launch-the-first-input-safely.md).

**Status:** done — merged to feature/software-factory

- [x] On a successful publication, increment the version under the same factory ID and commit the current pointer with the new definition. Failed or interrupted publication preserves the last committed version; publication never resumes a stopped or unmanaged factory.
- [x] Race admission against publication in both durable orders. Each receipt binds exactly one version; identical submission retries remain bound to the original. Queued and active work retain the preserved plan and resolved settings even if drafts, personas, aliases or defaults change.
- [x] Inspect current and bound versions separately in receipt, queue, run status and report; show which tool and skill policies inherit runtime availability. Do not treat live prerequisites, credentials or checkout contents as frozen.
- [x] Check the bound version's integrity and live prerequisites and ceilings before launch. An incompatible or damaged bound version blocks the head with the cause; do not substitute inputs, versions, models or limits.
- [x] Restore an older definition by validating and republishing the preserved version as a new version. Do not edit, delete, revoke or rewind old versions.
