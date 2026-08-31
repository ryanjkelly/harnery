---
"harnery": patch
---

Restore stale coordination-cache reaping in the reconcile pass. Both `agents reconcile` and the session-start pass now call one shared composition that runs the stale sweep before V3 session finalization and reports `swept_heartbeats`, `swept_pidmaps`, and `swept_peer_hashes`. Previously each called only the finalizer, so the sweep ran nowhere but its own uninvoked subcommand and stale rows accumulated indefinitely.

Also fix the finalizer predicate for `lifecycle.sweep_observed`, which matched `stale_sweep` (the finalization-request name) instead of `stale_heartbeat` (the observation the sweep emits). From a cold start that branch was unreachable, so a swept session never produced its finalization request.

The sweep's safety contract is unchanged: configured coordination freshness for valid rows, an extra stale-mtime gate for malformed or missing timestamps, a durable audit record before any deletion, and keeping the row when neither audit write can be persisted.
