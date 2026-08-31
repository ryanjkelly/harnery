---
"harnery": patch
---

Keep a blocked committer's staged paths in its durable claim set. When two sessions have unfinished changes in one file, the original claim holder's later commit is now blocked too instead of silently sweeping the other session's working-tree edits. Canonical Codex session rows also bypass the PID-based transient-identity heuristic because Windows-hosted sessions cross a process boundary and have no usable WSL PID anchor.
