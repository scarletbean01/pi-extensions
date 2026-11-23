# Decide concurrency and side-effect isolation

Type: grilling
Status: resolved
Assignee: deplague
Blocked by: 02

## Question

How should sequential and concurrent runs be configured, and what safeguards are needed for shared files and other side effects? Evaluate the present shared-working-directory and advisory ownership model, including conflicts across runs; decide what safety guarantees are required before concurrent execution can be enabled.

## Answer

- **One run per factory in the initial release.** A factory may durably accept more inputs while a run is active, subject to its queue limit, but there is no setting for overlapping runs within that factory. The graph retains its existing within-run parallelism and node ownership rules.
- **One factory run per checkout.** The factory launcher also prevents overlapping launches against the same checkout across different factories, regardless of how the checkout path is written. This coordinates factory-managed runs only. It does not prevent manual edits, standalone Bootstrap launches, or contention over shared resources such as Git refs, databases, ports, or deployment targets across checkouts.
- **Hold capacity through launch, human waiting, and uncertainty.** Reserve capacity before starting launch; stopping the factory or losing its manager does not free capacity. A run waiting for a person still holds capacity because it can resume or revise the checkout. Release capacity when launch is known not to have started execution or when execution is known to have settled; tab cleanup is not a prerequisite. If execution or effects remain uncertain, block the next conflicting launch until the operator inspects and explicitly clears the uncertainty. A missing heartbeat, a `cancelled` disposition or a closed tab is not sufficient evidence on its own. [Define durability and recovery guarantees](07-recovery.md) owns reconciliation and operator clearance.
- **FIFO within each factory.** Launch in durable acceptance order. Do not silently bypass a blocked head input. Before launch begins, the operator can explicitly discard the head input using the existing queued-input rule. FIFO is per factory; this does not define priority between factories sharing a checkout.
- **Later concurrency needs more than advisory ownership.** Before enabling overlapping runs within a factory, establish how their file changes are isolated and how they avoid or coordinate shared mutable side effects. Separate working directories alone are not enough. The initial release does not add automatic worktrees, a filesystem sandbox, or a general external resource lock.

## Evidence

- [Ownership scheduling](../../../bootstrap/ownership.ts#L298) derives writer waits from the current plan; [workers](../../../bootstrap/worker.ts#L444) evaluate them against the current run directory and roster.
- [Launch idempotency](../../../bootstrap/lifecycle.ts#L942) locks a request key and then the run, not the project directory.
- [Force-close handling](../../../bootstrap/lifecycle.ts#L3156) can record cancellation before tab closure is attempted; [cleanup](../../../bootstrap/lifecycle.ts#L2555) closes or reconciles Herdr resources, not detached processes or remote jobs.
