# Software Factory implementation

[Specification](../software-factory/spec.md) · [Implementation tickets](issues/)

## Branch policy

Create or switch to `feature/software-factory` before implementing [ticket 01](issues/01-publish-and-inspect-a-definition.md). Use it as the integration branch for all 14 tickets, including code, tests, and documentation. Do not implement directly on `main` or merge partial work into it. If work is parallelized in topic branches or worktrees, integrate it into `feature/software-factory`, not `main`.

Tickets [15](issues/15-add-a-deterministic-command-node.md) to [19](issues/19-propose-and-confirm-constraints.md) are post-release extensions and are not part of the 14-ticket release gate. A ticket among them that is not complete and verified when the gate runs stays on its own topic branch and is left out of the merge to `main`.

Run the [release gate](issues/14-verify-and-document-in-pi-herdr.md) against the integrated branch. Leave merging to `main` to a separate, explicit decision after that gate passes.
