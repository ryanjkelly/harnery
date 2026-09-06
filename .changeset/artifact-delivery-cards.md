---
"harnery": minor
---

Add zero-configuration delivery cards for managed artifact workspaces.

The new `artifacts delivery-card` command automatically lists safe, visible
root-level files and folders, capped at five entries. Optional saved web and
local destinations form an allowlist for remote results, friendly labels, and
nested files. The linked list uses concise labels, while the plain-text block
keeps the full copyable destinations. Artifact links automatically use a live
dashboard tunnel and fall back to the local dashboard when no matching tunnel
is running.
