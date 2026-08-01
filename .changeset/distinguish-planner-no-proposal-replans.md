---
"harnery": minor
---

Distinguish planner no-proposal replan exhaustion from reviewer rejection.

A durable goal can spend its replan budget two ways that used to look identical
once the budget ran out: a planner run that produced no proposal at all, and a
proposal that independent review then rejected across its bounded rounds. Both
left the goal quiescent with an undifferentiated exhaustion reason, so an
operator could not tell a planner that never proposed anything apart from
review-round exhaustion.

Governor projection now attributes each consumed replan through the existing
plan seams — a review receipt is present exactly when a proposal was produced
and reviewed, so its presence separates the two causes with no new record field
or planner mechanism. When any replan was a planner no-proposal outcome, the
projection carries a `replan_consumption` breakdown, the exhaustion reason names
the planner explicitly instead of reading as review-round exhaustion, and
`harn governor list` / `harn governor show` surface the distinction.

Budget accounting, cumulative counters, and append-only record authority are
unchanged. Records written before this change stay meaningful — a goal with no
planner no-proposal history projects and displays exactly as before, and the
new field is simply absent.
