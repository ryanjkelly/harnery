---
"harnery": minor
---

Derive backup snapshots from the storage catalog, enforce a configurable size limit, add per-host freshness throttling, and allow SessionStart to launch scheduled snapshots without delaying the agent. The detached runner owns no hook stdio, records its exit status for the next session's start-up context, and a local per-host freshness cache bounds remote restic round trips to about one per window.
