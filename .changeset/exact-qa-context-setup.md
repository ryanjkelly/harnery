---
"harnery": patch
---

Preserve setup arguments when a QA job context exactly matches required planner coverage, so deterministic gates and visual captures use the same setup. Reject conflicting context IDs or rendering identities instead of silently dropping their arguments or check targets.
