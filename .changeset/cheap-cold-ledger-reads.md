---
"harnery": patch
---

Make tool-use hooks and cold ledger reads cheaper. The pre- and post-tool-use hooks answer their session-name checks from the heartbeat cache and read the full ledger only when that cache cannot decide, which brings a hook pair from about 1.3 seconds to 0.3 seconds on a 22 MB active segment. Event validation checks only the union member named by `event_type`, and canonical JSON skips Unicode normalization for ASCII strings and keys; both produce identical results and roughly halve the remaining full-read validation cost.
