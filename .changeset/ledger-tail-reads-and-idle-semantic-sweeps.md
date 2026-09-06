---
"harnery": patch
---

Read the event ledger tail through the validated snapshot cache in `readLedgerV3Since`
instead of rediscovering and revalidating every frame per call. A poller now pays for the
bytes appended since its last read; on a 24 MB active segment a no-change read drops from
about half a second to nothing.

Back the semantic service's fallback wake timer off while sweeps find nothing (doubling up
to 30 seconds) and snap it back on the first new event or pass. The ledger watcher still
wakes it immediately on an append, and a stop request wakes a backed-off wait at once.
