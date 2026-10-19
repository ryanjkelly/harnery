---
"harnery": patch
---

Session start does less work. The stale sweep and cache cleanup no longer take a generation-custody lock per instance or run a crash-recoverable delete protocol for heartbeat and pid-map cache files; those files are disposable copies of the coordination ledger. This reverts the 0.44.0 change recorded in ADR 0215, which is now withdrawn.
