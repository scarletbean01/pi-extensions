# 12: Bind human approval to a valid decision result

**What to build:** A human can choose approval when an enabled decision node asks. The recorded choice binds that attempt's verdict, but only a valid successful result can route the run. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [09: Ask for and record human direction](09-ask-for-and-record-human-direction.md).

**Status:** done

- [x] Only an intervention-enabled decision node can offer a routing choice, mapped by the published plan to its existing verdict. Bind a selected route to one attempt; later clarification cannot replace it. Without a selected route, the attempt may supply its own verdict only where the plan permits.
- [x] Supply the verdict from the recorded choice at completion and reject a conflicting submission. Surface guidance incompatible with the plan or route; if it cannot be resolved within the assignment, report non-success without taking either route.
- [x] Continue to enforce contracts, required checks, artifact integrity and normal successor admission. Approval finalizes the loop and fires only declared forward edges. At a terminal decision node it finishes that branch; independent work remains governed by ordinary run settlement.
- [x] Inspect response recorded, response consumed, verdict recorded, and successor or revision admitted as distinct observations; show unknown or inapplicable states. Verify the cases where an earlier stage has happened but the next has not.
- [x] Exercise conflicting verdict/guidance, failed contracts or checks, a valid approval whose successor has not admitted, and terminal approval while other work remains active. Agents still route; the managing session only records the human choice.
