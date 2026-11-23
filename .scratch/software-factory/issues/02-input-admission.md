# Define input submission and admission

Type: grilling
Status: resolved
Assignee: deplague
Blocked by: none

## Question

What constitutes a factory input, how does a person submit one from the Pi/Herdr environment, and what admission and acknowledgement guarantees are needed? Address pending inputs, duplicate submissions and the boundary for future automated sources without requiring an initial trigger integration.

## Answer

- **Input and authority.** The initial input is a non-blank plain-text work brief, including multiline text, submitted to one factory. Mentions of files or issues are just text: submission does not fetch or attach them. The factory definition, not the input, controls the project, graph and agent permissions.
- **Manual submission.** A person uses an explicit Pi command in the managing Herdr tab to identify the factory and enter or paste the brief. The command submits directly; ordinary chat is not submission, and no model interpretation or additional confirmation is required.
- **Admission and acknowledgement.** The managing session acknowledges acceptance only after the input is durably recorded. The acknowledgement includes a stable input ID, even if all launch capacity is busy. Acceptance means the work was recorded, not that a run exists or will succeed. Definitive non-acceptance (e.g. a stopped factory, an invalid brief, a full queue or a confirmed write failure) includes the reason. An uncertain write is reported as uncertain and is checked by submission reference, not treated as a reason to submit afresh.
- **Retries and intentional repeats.** The command exposes a submission reference before committing. Within a factory, the same reference and same brief return the existing input ID and current status, without adding a queue entry or starting another run. Reusing the reference with different text is a conflict. A fresh submission uses a new reference and is distinct even if its text matches. Checking a receipt is read-only, not a new admission.
- **Queued inputs.** Accepted briefs are immutable. An explicit discard can remove a queued input from launch eligibility only if launch has not begun. Its discarded status remains recorded so a retry cannot revive it. To correct a brief, discard it and submit a replacement; once launch begins, use run controls instead. Bound brief size and queue depth; reject work above the applicable limit rather than silently dropping accepted inputs. Exact limits belong in the build spec.
- **Future sources.** A trigger or web wrapper can submit a factory target, brief and stable source submission reference through the same admission boundary. It does not get a separate path around the managing session, admission limits or acknowledgement rules. No trigger integration or web UI is required in the initial delivery.

## Boundaries for later decisions

- Admission is distinct from launching. Bootstrap's [`request_id`](../../../bootstrap/README.md#workflow) is for launch idempotency: it returns the original run for an equivalent plan and rejects changed plans under that key. It cannot acknowledge an input that has not been launched. [Define durability and recovery guarantees](07-recovery.md) owns launch reconciliation and the input-to-run association after interruptions; do not automatically launch again when prior execution is uncertain.
- Queue scheduling and launch capacity belong to [Decide concurrency and side-effect isolation](05-concurrency-isolation.md); which definition governs queued work belongs to [Define factory definition changes](06-versioning.md). Detailed queue and receipt presentation belongs to [Define factory operation and visibility](08-observability.md).
