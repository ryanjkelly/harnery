---
"harnery": minor
---

Add `artifacts remove <ref> --reason <text> [--yes]` to preview or immediately
delete one reviewed workspace belonging to the current agent. Removal preserves
holds, peer claims, tracked files, and filesystem safety checks, and records
the reason and actor in the deletion log.
