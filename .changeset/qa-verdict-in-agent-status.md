---
"harnery": minor
---

`agents status` now shows the session's latest page-QA verdict on the runner's
own clock, so runner time is never read off session age. A new `qa` line
renders as `passed 4m ago · 90s runner (2m queued)`, reporting the verdict, how
long ago the run completed, and how long the runner took, with admission-queue
wait shown separately because it is never part of runner total. Hand-recorded
evidence renders `manual 12m ago · not a pass` rather than a verdict and a
clock, and a result older than 24 hours collapses to `stale (2d)`. The line is
absent when the session has recorded no run. Backing this is a per-session
pointer at `.harnery/qa/<instance-id>.json`, written atomically by the command
layer (the matrix runner is toolkit tier and cannot reach the coordination
core). Every read is best-effort: a missing, unreadable, or partial pointer
renders no line and can never fail the status command.
