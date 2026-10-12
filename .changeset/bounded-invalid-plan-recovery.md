---
"harnery": patch
---

Keep governor runs moving after a planner returns an invalid dependency graph. Record the failed plan and charge the existing replan budget, then let the governor retry within its frozen limits. Workflow, storage, and persisted review-input failures keep their existing error behavior.
