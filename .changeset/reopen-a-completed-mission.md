---
"harnery": minor
---

Let an operator finding reach work beneath a completed mission

`harn work reopen --finding` on an item whose goal had already succeeded moved the item to
`ready` and then went nowhere. The goal projection short-circuited to `succeeded` /
`next_action: none` the moment a mission had an accepted completion, so the governor
never dispatched the reopened item and no CLI output said why.

A reopen under a succeeded mission now reopens the mission. A superseding `plan.reopened`
event is appended beside the accepted `plan.completed`, which stays in the log unchanged,
and the goal returns to ordinary dispatch with the reopened work ahead of any milestone
reassessment. Reopening twice is idempotent, and a mission that never completed refuses.
