# Factory web viewer: a local, read-only dashboard

Status: ready-for-agent. Prepared 2026-11-23 from the design `docs/factory-web-viewer.md`, with the test seam confirmed with the user (the viewer's HTTP snapshot API). Vocabulary follows `GLOSSARY.md` (software factory, factory definition version, factory input, input admission, submission reference, launch attempt, capacity hold, run, run graph, node, attempt, edge, join, feedback edge, settlement, outstanding attention, direction request, response recorded / consumed, constraint proposal). Architecture follows ADR 0001: agents drive graph execution; the viewer observes and never drives.

## Problem Statement

An operator who runs a software factory can follow it only from inside Pi and Herdr:

- To see what a factory is doing, they must open Pi, run `/factory` commands, and read text. There is no picture of the run's nodes, dependencies, joins and feedback edges that stays current.
- The question "what needs my attention?" is spread over several commands: current version, management and stop state, capacity, why the first queued input cannot launch, pending direction requests, constraint proposals, uncertain evidence.
- When a newer definition version has been published, it is easy to confuse what a running run actually launched with what the factory would launch now.
- Looking at the factory must be safe. Existing standalone run status and widget paths can repair or clean up eligible runs, so a casual look must not be able to change anything.
- The operator may have no Pi session managing the factory at all, and still wants to see what the records support.

## Solution

A local, read-only web dashboard, started by one terminal command that prints its loopback URL:

- A **Factories** sidebar lists the factories from the same configured state directory as `/factory list`. Selecting one opens its **Live Graph**.
- Seven views cover Factories, Live Graph, Inspect, Queue, Receipts, Requests and Proposals, each showing only operator-facing summaries and identifiers.
- The Live Graph draws the verified released run's topology (the run's bound version, not the current one), refreshes about every two seconds without disturbing pan, zoom, selection or focus, and follows the next verified run automatically.
- Uncertainty is first class: **Uncertain** is distinct from **Idle** and **Running**, and **Stale** (a failed refresh) is distinct from a fresh read that reports uncertainty.
- Inspect opens with "What needs my attention?" and makes node relationships navigable inside a chosen definition version.
- The viewer never writes, migrates, repairs, reconciles, settles, launches or cleans up. All factory actions stay in Pi. It runs independently of Pi, Herdr and factory management.
- Materialize CSS provides layout and navigation, served locally with no runtime CDN or font requests.

## User Stories

Starting and scope

1. As an operator, I want one terminal command that starts the viewer and prints its loopback URL, so that I can open the dashboard without configuring anything.
2. As an operator, I want the viewer to listen only on the loopback interface, so that factory state is not exposed to the network.
3. As an operator, I want the viewer to run without Pi, Herdr or a managing factory session, so that I can look at a factory whose manager is closed.
4. As an operator, I want stopping the viewer to stop only the viewer, so that no factory, run or Pi session is affected.
5. As an operator, I want the sidebar to list the same factories as `/factory list`, so that the dashboard and Pi agree on what exists.
6. As an operator, I want the viewer not to discover other directories or hosts, so that it never shows state I did not configure.
7. As an operator, I want pages to load with no CDN, font or other external requests, so that the viewer works offline and leaks nothing.

Factories view and navigation

8. As an operator, I want a list of published factories with their names, current versions and recorded management state where available, so that I can choose which one to follow.
9. As an operator, I want selecting a factory to open its Live Graph, so that the most useful view is one click away.
10. As an operator on a desktop, I want the Factories sidebar always visible, so that I can switch factories quickly.
11. As an operator on a narrow screen, I want the sidebar to become a drawer I can open and close with the keyboard, so that the dashboard stays usable on a small display.
12. As an operator, I want switching factories never to show the previous factory's graph, so that I cannot act on the wrong factory's picture.

Live Graph

13. As an operator, I want to see the nodes, dependency edges, joins and distinct feedback edges of the verified released run, so that I understand the run's shape at a glance.
14. As an operator, I want the graph to use the topology that actually launched rather than the factory's current definition, so that a newer publication does not rewrite history.
15. As an operator, I want the run's bound version shown separately from the current version, so that I can see when a run is on an older definition.
16. As an operator, I want each node's status shown as text as well as color, so that I can read status without relying on color.
17. As an operator, I want to select a node and see details of its current attempt, so that I can see what it is doing.
18. As an operator, I want a waiting, blocked or uncertain node to explain why when the evidence gives a reason, so that I know what is holding it.
19. As an operator, I want a **View configuration** action on a node that opens that node in Inspect at the run's bound version, so that I see the configuration that actually ran.
20. As an operator, I want the graph to refresh about every two seconds while I am watching a factory, including while it waits for its next run, so that I see changes without reloading.
21. As an operator, I want a refresh on the same run not to reset pan, zoom, selected node or keyboard focus, so that I can inspect a node while the run updates around me.
22. As an operator, I want the graph to switch automatically to the next verified run, so that I can leave the dashboard open.
23. As an operator, I want a reserved or failed-before-release launch not to be drawn as a live graph, so that nothing that never released looks like it is running.
24. As an operator, I want missing or inconsistent release evidence shown as **Uncertain** rather than **Idle** or **Running**, so that I am not reassured by a guess.
25. As an operator, I want run outcome, execution settlement and release of capacity shown as distinct facts, so that a finished outcome is not mistaken for released capacity.
26. As an operator, I want a finished run's final outcome to stay visible until another run starts or I switch factories, so that I do not miss how it ended.
27. As an operator, I want an ended run's graph never presented as active, so that I do not mistake it for live work.
28. As an operator, I want an idle, waiting or blocked factory to show that state with a reason where known, so that an empty graph is explained.
29. As an operator, I want a failed refresh to keep the last good snapshot for the selected factory labelled **Stale** with the time it was last checked successfully, so that I know how old what I am looking at is.
30. As an operator, I want recovery from a failed refresh to clear the stale indicator, so that I can trust the display again.
31. As an operator, I want a stale snapshot kept visibly different from a fresh read that reports uncertainty, so that I can tell a connection problem from a records problem.

Inspect

32. As an operator, I want Inspect to start with "What needs my attention?" covering name, management and stop state, current version, factory and checkout capacity, queue-head blocker and outstanding attention, so that one screen answers whether I must act.
33. As an operator, I want explanations of what is known and why, not raw status codes, so that I can act without decoding internals.
34. As an operator, I want a definition version selector listing retained versions, so that I can inspect a past or current definition.
35. As an operator, I want changing the version selector not to change the published current version or time-travel the queue and capacity views, so that I never confuse a past definition with the live factory.
36. As an operator, I want inspected version, current version, retained versions, restore provenance, unavailable or damaged records, and what the definition does not freeze shown together, so that I understand version history and gaps.
37. As an operator, I want each node's ID and kind, persona and model where applicable, declared or inherited policies, dependencies, joins, decision and feedback targets, required checks and limits as labelled fields, so that I can read configuration without a JSON dump.
38. As an operator, I want an operation-and-evidence summary of launch attempts, bound versions, input admission and settlement or clearance, capacity evidence and blockers, requests, proposals and outstanding attention, so that I can see the state behind the picture.
39. As an operator, I want that summary to link to the relevant detail view rather than duplicate whole tables, so that Inspect stays readable.
40. As an operator, I want node references in dependencies, joins and feedback targets to be links to that node's configuration in the same factory and definition version, so that I can follow the graph through configuration.
41. As an operator, I want following a link to open its containing section, reveal the target and move keyboard focus there, so that I do not hunt for where I landed.
42. As an operator, I want a link from a run bound to an older version to open the target in that older version even after a newer one is published, so that links tell the truth about what ran.
43. As an operator, I want an unverifiable link target to be explained, not silently redirected to another version, so that I never read the wrong configuration.
44. As an operator, I want accordions only for optional detail, never for the main summary or a blocker, so that nothing important is hidden by default.
45. As an operator, I want expanded sections and focus preserved across refreshes, so that updates do not undo my reading position.
46. As an operator, I want **no records**, **not applicable** and **evidence unavailable** shown as different things, so that I can tell an empty list from a missing one.

Queue

47. As an operator, I want to see FIFO inputs in order, so that I know what will launch next.
48. As an operator, I want the reason the first waiting input cannot launch, if any, so that I know what is blocking the queue.
49. As an operator, I want an **Open** filter that keeps unfinished and uncertain entries, so that I focus on live work.
50. As an operator, I want an **All** filter that also shows finished entries, so that I can review what has completed.
51. As an operator, I want a queue row to link to its receipt, so that I can see the admission details.

Receipts

52. As an operator, I want to look up a receipt by submission reference, so that I can confirm what happened to a submitted input.
53. As an operator, I want a receipt to show the admission, bound version, disposition and recorded launch attempt details where available, so that I see the input's whole path.
54. As an operator, I want a receipt clearly distinguished from a run report, so that I do not read it as a statement about run results.
55. As an operator, I want a lookup for an unknown reference to say so plainly, so that a typo is not shown as an empty receipt.

Requests

56. As an operator, I want to see direction and exhaustion requests with the question and choices where available, so that I know what the factory is asking.
57. As an operator, I want the response recorded and the response consumed shown as separate observations, so that I can see whether an answer was actually acted on.
58. As an operator, I want uncertainty in a request shown, so that I know when the record is not clear.
59. As an operator, I want no respond or wake controls, so that answering stays in Pi.

Proposals

60. As an operator, I want to see learned constraint proposals with provenance, outcomes and file sync state where available, so that I know what the factory has proposed to learn.
61. As an operator, I want the Proposals view not to claim to show the active constraints file, so that I do not mistake proposals for rules in force.
62. As an operator, I want no review, approval or resolution controls, so that decisions stay in Pi.

Read-only guarantees

63. As an operator, I want starting the viewer, loading pages, following links and refreshing never to write, migrate, repair, reconcile on disk, settle, launch or clean up factory or Bootstrap state, so that looking is always safe.
64. As an operator, I want graph reads to verify the factory binding and release for the selected factory and never fall through to generic standalone run status or widget paths, so that no repair or cleanup of a standalone run can be triggered by viewing.
65. As an operator, I want the viewer to expose only the fields its views need, so that raw store records and arbitrary tool calls are never reachable from the browser.
66. As an operator, I want the viewer to ignore filesystem paths supplied by the browser, so that a request cannot read outside the configured state.
67. As an operator, I want raw prompts, full input briefs, logs and internal records kept out of the browser, so that sensitive material stays in Pi.
68. As an operator, I want a damaged or unreadable factory record shown as unavailable evidence, so that one bad record does not take down the dashboard or trigger recovery.

Accessibility

69. As a keyboard-only operator, I want all navigation, version selection and link following to work from the keyboard with visible focus, so that I do not need a mouse.
70. As an operator using assistive technology, I want semantic headings and tables and meaningful link labels, so that the pages can be navigated and understood.
71. As an operator, I want status cues that do not rely on color alone, so that the dashboard is usable regardless of color vision.

## Implementation Decisions

- **One module boundary: the viewer.** A viewer service owns the loopback HTTP server, the read model for each view, and the static assets. It is started by one terminal command which prints the loopback URL. It has no dependency on Pi sessions, Herdr, or a running factory manager.
- **HTTP snapshot API is the single public interface.** Each view has a read-only JSON snapshot endpoint, plus the static pages. Selection is by factory identifier and, for Inspect, a definition version identifier; receipts are by submission reference. The API accepts only these identifiers, never a path, and only GET requests. Any other method is rejected.
- **Reuse existing read-only factory operations and their evidence rules.** The read model is built from the same list, inspect, receipt and queue observations that back `/factory list`, `/factory inspect` and `/factory receipt`, projecting only the fields needed by each view. It adds no new writing path and no new evidence rules.
- **Read-only is enforced, not assumed.** The viewer opens factory and Bootstrap stores read-only and never invokes operations that can resume, repair, migrate, reconcile, settle, launch or clean up. An inspection that would need hot-journal recovery reports evidence unavailable rather than recovering.
- **Graph source is verified factory release.** The Live Graph is derived from the run bound to the selected factory's verified release, using that run's bound definition version for topology (a run graph in glossary terms). It must not call generic standalone run status or widget paths, because those can repair or clean up standalone runs. A launch that is only reserved, or that failed before release, yields no graph. Missing or inconsistent release evidence yields an explicit **Uncertain** state.
- **Graph snapshot carries state, not layout.** The snapshot returns nodes, dependency edges, joins, feedback edges, per-node status text and reasons, the run's bound version, the current version, and distinct outcome, settlement and capacity-release facts. Layout and drawing are left to the page. Where possible the snapshot reuses the existing graph view model's node and edge states and loop information.
- **Top-level state is a closed set.** A selected factory's live state is one of: running (verified run), ended (final outcome retained), idle, waiting, blocked, uncertain. Each carries a reason where known. **Stale** is a client-side overlay for a failed refresh and is not a value the server reports.
- **Freshness contract.** The page polls roughly every two seconds while a factory is watched, including when idle. Snapshots carry an identity for the run and a checked-at time, so the page can update in place for the same run, switch on a new verified run, retain a finished outcome until a new run starts or the factory changes, and label the last good snapshot **Stale** with its last successful check time. A snapshot for factory A is never rendered while factory B is selected.
- **Version-bound navigation.** Inspect addresses a definition version explicitly. Node links carry the factory, version and node identifiers. A link whose target cannot be verified in that version produces an explanation, never a redirect to another version. The version selector changes only the inspected definition; queue, capacity and attention stay current.
- **Absence is typed.** Every list or field that may be empty distinguishes `no records`, `not applicable` and `evidence unavailable` in the snapshot, so the page can render each differently.
- **Operator-facing projection only.** Snapshots exclude raw prompts, full input briefs, logs, internal records, store paths and raw status codes without explanation. Identifiers useful to operators (factory, input, submission reference, attempt, task, request, proposal) are included.
- **Requests and proposals are observations.** Requests expose question, choices, and separately the recorded and consumed response observations, with uncertainty. Proposals expose provenance, outcome and file sync state, and are explicitly not the active constraints file. Neither exposes any action.
- **UI stack.** Materialize CSS provides layout, navigation and information views, with all assets, including icons and fonts, served locally by the viewer. No runtime CDN or font request. The sidebar is persistent on desktop and a keyboard-accessible drawer on narrow screens. Status always has a text cue. Headings and tables are semantic, links have meaningful labels, and focus is visible and preserved across refreshes.
- **Out of scope controls are absent.** There are no submit, publish, stop, cancel, resume, response or proposal action controls, and no endpoint that could perform them.
- **Vocabulary.** The `GLOSSARY.md` entry for **Run graph** (a view of one run's nodes and edges with observed state, whose topology for a factory run comes from the version bound to that run's input) is the term this spec uses; do not use "factory definition graph" for a specific run.

## Testing Decisions

- **What makes a good test:** it drives the viewer through its public HTTP interface only and asserts on the response body and on observable store state. It does not reach into the read-model internals, the page's DOM structure, or helper functions.
- **One seam: the HTTP snapshot API**, run against fixture factory state directories built with the existing factory and Bootstrap test fixtures (a fake Herdr executor, simulated runs, published versions). Every behaviour below is tested here:
  - Factory list matches `/factory list` for the same state directory and excludes other directories.
  - A verified `v2` run while `v3` is current returns v2 topology, both versions, and node links that resolve in `v2`.
  - No released run: a known launch blocker is explained; contradictory release evidence returns uncertain; a reserved or failed-before-release launch returns no graph; a verified release returns the graph.
  - Run end keeps the final outcome until a new run, and outcome, settlement and capacity release are reported separately (a finished outcome with a held capacity hold stays held).
  - Selecting factory B never returns factory A's graph.
  - Queue Open versus All filtering, queue-head blocker, and the link from a row to its receipt.
  - Receipt lookup by submission reference, including unknown reference, and that a receipt is not reported as a run report.
  - Requests show recorded and consumed as separate observations and expose no action; proposals show provenance, outcome and sync state.
  - Inspect version selection leaves current-state fields unchanged; an unverifiable link target yields an explanation, not a different version.
  - Typed absence: no records, not applicable and evidence unavailable are distinguishable.
  - Projection: no prompts, briefs, logs, store paths or raw internal records appear in any response.
  - Paths or arbitrary identifiers supplied by the client cannot read outside the configured state; non-GET methods are rejected.
- **Read-only proof:** a test helper snapshots the whole fixture state (store files, run records, journals, holds) before a sequence of requests (starting the viewer, loading every view, following links, polling repeatedly, with the manager closed and with a hot journal or damaged record present) and asserts it is byte-for-byte unchanged afterward, and that no Herdr call, launch, settlement or cleanup happened.
- **Stale handling** is a client behaviour; the server contract is tested by checking that snapshots carry a run identity and checked-at time and that a failing read yields an error response rather than a fabricated snapshot.
- **Manual acceptance (not automated, by decision):** browser behaviour that the HTTP seam cannot see: pan, zoom, selected node and keyboard focus surviving refresh; accessibility (keyboard-only use, drawer, visible focus, text status cues); no external requests on page load; Materialize layout. Use the five acceptance scenarios in the design doc as the manual checklist.
- **Prior art:** the factory operation tests for list, inspect, receipt and queue evidence; the graph view tests; the factory launch, release-gate and settlement tests for verified release, uncertainty and capacity facts; and the run fixture for simulated runs.

## Out of Scope

- Remote access, other hosts, or discovery of other state directories.
- A historical run graph browser; only the active or most recent observed run is drawn. Retained definition versions, finished queue entries and receipt lookup are in scope.
- A raw JSON console, store browser or arbitrary tool-call interface.
- Submit, publish, stop, cancel, resume, response and proposal action controls; all factory actions stay in Pi.
- Taking over or resuming factory management, or any repair, migration, reconciliation, settlement or cleanup.
- Showing the active constraints file, raw prompts, full input briefs or logs.
- Automated browser (DOM) tests; those behaviours are covered by the manual checklist for v1.

## Further Notes

- The design lives in `docs/factory-web-viewer.md`. It is an uncommitted draft; it should be committed alongside the implementation and gain operating documentation then (see the existing factory operating guide and versions documents, and the Bootstrap graph widget documentation, for the behaviour the viewer mirrors).
- The `GLOSSARY.md` addition for **Run graph** is also uncommitted and should land with this work.
- The loopback address and port selection (fixed default versus ephemeral) and the exact command name are open implementation choices; the requirement is one command that prints the URL.
- Because graph reads must avoid the generic run status and widget paths, expect to need a small read-only graph projection for factory runs. Keep it free of any code path that can write.
- Suggested ticket order for `/engineering to-tickets`: read-only harness and state-directory proof first (a skeleton viewer with the factory list and the byte-for-byte unchanged check), then Inspect and version-bound links, Live Graph snapshot with stale, uncertain and ended states, Queue and Receipts, Requests and Proposals, then the page layer (Materialize, drawer, polling, focus preservation) and the manual checklist.
