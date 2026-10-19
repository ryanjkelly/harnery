---
"harnery": patch
---

Workspace allocation no longer takes a provider-wide publication lease or scans the reservation directory before writing each claim, and reclaim and cleanup no longer hold a per-binding reclaim reservation. Reclaim still refuses before changing any file when a retained peer workspace overlaps the target, and rechecks that before each destructive step and before removing the worktree.
