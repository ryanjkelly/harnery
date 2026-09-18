---
"harnery": patch
---

Accumulate command output counts and fingerprints in bounded memory, then record
one summary per stream at completion or process exit. Streaming output no longer
pays a durable ledger write for every emission. Forced termination can lose
unflushed output summaries; command start and completion retain their existing
durability.
