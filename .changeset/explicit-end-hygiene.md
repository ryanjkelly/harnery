---
"harnery": minor
---

Pending explicit-end requests can no longer wedge forever. A request whose
allowed span never closes is cancelled (never terminalized) after a 24-hour
grace period — cancellation is safe because re-requesting is cheap — and a
repeated explicit end now reports its exact blocker (open span ids, turn
state, pending age) alongside the existing request instead of a bare
already-requested result. The finalization reconciler also drains the hook
intake spool at the start of every pass, acting as the terminal drainer for
signals whose appender lost the state lease and exited.
