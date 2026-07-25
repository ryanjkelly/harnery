---
"harnery": minor
---

Add `harn workflow reclaim <run-id>`, which resolves a workspace stuck at `preserved_dirty`.

Preserving a dirty worktree was already correct, and it was also permanent: cleanup re-attempted, found the tree still dirty, preserved again, and incremented a counter. The only exit was to leave Harnery and remove the directory by hand.

Reclaim salvages the uncommitted work to a durable `harnery/salvage/<run-id>` branch, then hands off to the ordinary cleanup path to release the now-clean workspace. `--discard` throws the work away instead, and is never the default. Neither mode deletes anything itself, so cleanup remains the only path that removes a worktree.

Salvage commits and then rewinds the checked-out branch, because cleanup deletes the workspace branch and pins its OID in a frozen intent. A workspace whose directory is already gone reports `already_gone` rather than incrementing attempts forever.

`harn workflow workspace <run-id>` now lists the dirty paths alongside the count it already printed.
