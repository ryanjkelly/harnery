---
"harnery": minor
---

Let a workflow stop because a human must rule, and tell that apart from failing.

A script that concluded correctly — "this needs a person" — had no way to say so. Its only exit was `throw`, which means the opposite: the work failed, and a retry might do better. So a correct refusal and a botched attempt reached the engine as the same outcome, and everything downstream treated them the same way. A goal running with `retry_blocked` re-issued the item, the next agent reached the same correct conclusion, and the loop repeated until the attempt budget was gone. Nobody was told, because the thing it was waiting on was a person nobody had asked.

`ctx.blocked()` names that outcome:

```js
ctx.blocked({
  reason: "which subsystem owns the cart is unsettled",
  decision: "who-owns-the-cart-2026-08-01-beaf",
});
```

The run fails with class `decision`, a third member of the `environment` / `upstream` family from ADR 0046. Like those, it means the attempt was uninformative about the work, so it is uncharged and the item retries with a full budget once the ruling lands. Unlike a work failure, it is terminal: the work item goes to `blocked` with `next_action: "none"`, which is what puts it out of `retry_blocked`'s reach. That automation exists to clear failures without a human, and a correct refusal is not a failure.

A planner can block the same way, and the goal stops rather than replanning a question the planner already answered.

The point of the class is that a human finds out. A goal holding blocked work says what it is waiting on and names the decision, instead of reporting a count of items "needing intervention" — a phrasing that reads like a queue an agent will get to. `GovernorProjection.decision_blocked_work` carries the work/decision pairs, and `WorkProjection.blocked_on_decision` marks the item, so a dashboard or digest never has to parse reason prose to find what is parked on a person.

Passing the docket id is what turns "something needs a human" into a question someone can answer. Blocking without one still stops the item; the operator just has to go find the question themselves.
