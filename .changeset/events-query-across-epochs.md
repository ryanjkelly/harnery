---
"harnery": minor
---

Add `harn events epochs` and `harn events query`, which read the active ledger epoch and every retained archive as one history. The active file alone covers only the time since the last size rotation. The shipped agent instructions now mention the archives and point to `events query`.
