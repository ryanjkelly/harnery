---
"harnery": patch
---

Add guarded removal of clean repository copies inside an owned artifact. The command refuses unpublished HEAD, branch and tag commits, uncommitted work, and registered worktrees while preserving the surrounding artifact and evidence.
