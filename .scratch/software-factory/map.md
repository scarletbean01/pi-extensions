# Wayfinder: Persistent software factory

## Destination

A buildable specification for a persistent Bootstrap software factory that accepts inputs, starts a separate run per input, supports bounded human-directed revision, and remains available for later inputs.

## Notes

- Consult `GLOSSARY.md`, `bootstrap/README.md`, `GRAPH-SPEC.md`, and `docs/adr/0001-agents-drive-graph-execution.md`; check current code rather than assuming historical plans reflect it.
- Consult the engineering wayfinder, domain-modeling and productivity grilling guides when working the map.
- Start with manual inputs and Pi/Herdr interaction. Design to accommodate automated triggers and a web wrapper later; neither is an initial delivery requirement.
- Human intervention is enabled by the graph author and requested dynamically by agents when needed. Allowed routing outcomes are defined by the plan; free-text guidance may accompany a choice.
- The destination includes lifecycle, monitoring and recovery, not a general-purpose workflow platform. This map produces decisions, not implementation.

## Decisions so far

- [Define the factory lifecycle and runtime ownership](issues/01-factory-lifecycle.md): a single managing session handles admission and launching; resumption is explicit, while active runs and queued inputs are not cancelled by stopping the factory.
- [Define input submission and admission](issues/02-input-admission.md): explicit Pi submission of a plain-text brief is acknowledged on durable acceptance, independently of launch, with safe retries by submission reference.
- [Define dynamic human intervention](issues/03-human-intervention.md): enabled agents may request durable human direction, waiting without turning silence into a choice while independent work continues.
- [Define human-directed graph routing](issues/04-directed-routing.md): a recorded routing choice binds an attempt’s existing approval or rejection verdict without bypassing checks, revision limits, or other planned work.
- [Decide concurrency and side-effect isolation](issues/05-concurrency-isolation.md): launch in acceptance order, one run per factory and checkout; a run waiting for a person or with uncertain execution keeps its slot.
- [Define factory definition changes](issues/06-versioning.md): explicitly publish validated, immutable versions; inputs keep the version current at durable acceptance, and launch never silently substitutes another.
- [Define durability and recovery guarantees](issues/07-recovery.md): preserve records and capacity holds across local crashes, reconcile on explicit takeover, and never replay work that may have executed.

- [Define factory operation and visibility](issues/08-observability.md): provide Pi/Herdr status and alerts backed by durable evidence, and require human confirmation for sensitive controls without bypassing eligibility checks.

## Not yet specified

None identified. Specify the delivery stages and exact Pi interfaces in the build specification.

## Out of scope

- Initial implementation of automated trigger integrations or a web application wrapper; both are possible future extensions.
- A general-purpose workflow platform.
