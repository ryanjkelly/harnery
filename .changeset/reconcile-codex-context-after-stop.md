---
"harnery": patch
---

Reconcile Codex context usage after the synchronous Stop hook releases the
harness, so completed pathless turns produce exact V3 observations without
waiting for another hook.
