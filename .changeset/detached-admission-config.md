---
"harnery": patch
---

Detached `admission run --detach` jobs now wait out configured memory pressure before queueing, record that wait in the history, and pass `HARNERY_ADMISSION_HELD` to their command, matching foreground runs.
