---
"harnery": minor
---

Add session closeout support. `agents release-claim --all` releases every claim the current session holds. `agents lifecycle done` now refuses while the session still holds file claims and names that remedy. `artifacts list --mine --min-bytes <n>` narrows the inventory to the current session's workspaces at or above a disk-use threshold. Totals and budget warnings still cover the whole store.
