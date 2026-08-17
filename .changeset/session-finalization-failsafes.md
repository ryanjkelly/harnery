---
"harnery": minor
---

Add one crash-safe V2 session finalizer for native callbacks, explicit end,
verified archive, idle timeout, parent/run and delegated-agent cascades, stale
sweeps, supersession, and host disappearance. New `agents end`, `reconcile`,
archive-observation, and host-observation commands provide manual and supervised
recovery paths without deleting heartbeat projections or inventing native
telemetry. Explicit end requests made from inside a live adapter turn are now
durably deferred until that exact turn and its existing tool spans close; new
work cancels the request. `agents status --end-turn --end-session` provides one
safe final command for the `/end` workflow.
