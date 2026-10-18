---
"harnery": patch
---

Bind context recovery acceptance to the exact prepared checkpoint and task instance. Refuse stale or mismatched acceptance without changing newer state, and keep repeated completion idempotent.
