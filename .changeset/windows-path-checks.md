---
"harnery": patch
---

Two path checks work on Windows. Recording a page-QA signal no longer refuses every write as escaping `.harnery/qa/`: the containment check used a `/` separator that Windows paths never contain. `harn rm`'s clean-clone mode no longer refuses every clone as a linked worktree: it compared Git's forward-slash worktree path with the Windows path as text, and now compares real paths.
