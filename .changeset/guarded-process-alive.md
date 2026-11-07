---
"harnery": patch
---

The pid-map, hook run-marker, and supervisor service liveness checks share one probe that never treats a process id of zero or below as alive. Signal 0 sent to id 0 reaches the caller's own process group, so a missing id could previously read as a live process.
