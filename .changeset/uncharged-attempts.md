---
"harnery": minor
---

Charge a durable-work attempt only when it produced information about the work
(ADR 0046). A failure that never touched the work no longer spends the fixed
`max_attempts` budget, and the two ways a run can be uninformative get opposite
handling.

An **environment** failure — the vendor binary was absent, so the run never
started — stops the item immediately and names the missing precondition, instead
of retrying an unchanged `PATH` until the budget runs out. It is detected
structurally: `exec()` now surfaces the spawn errno (`ENOENT`), carried through
`HarnessRawResult` to each adapter, so a genuine missing binary is distinguished
from a shell that merely exits 127.

An **upstream** failure — the vendor was reached and refused (5xx, 429, circuit
open) — goes uncharged but stays retryable, bounded by a new, separate
`max_uncharged_attempts` (default 3) so an outage that never ends cannot retry
forever; at the bound the item reports it is blocked waiting on an outside
service, distinct from blocked on the work.

Anything not positively identified as environment or upstream is charged exactly
as before, so a proof or attempt written before this change behaves unchanged.
The projection gains `charged_attempts` alongside `attempts_used`: `max_attempts`
now budgets charged attempts, while `attempts_used` still counts every attempt
for history ordering and the next attempt number.

The same rule governs the supervisor's replan budget, where most of the measured
bleed occurred: a planner run that never touched the plan is classified from its
proof and stamped on the `plan.failed` event, so an environment failure stops the
goal and names the precondition instead of replanning an unchanged environment,
and consecutive upstream failures go uncharged against `max_replans`, bounded by a
small consecutive limit. The in-agent spawn-retry loop also stops immediately on
an environment failure rather than re-spawning an absent binary.
