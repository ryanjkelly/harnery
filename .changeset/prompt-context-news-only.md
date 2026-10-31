---
"harnery": minor
---

Per-prompt context now carries only news. The peer table reprints when a live
peer arrives, leaves, changes lifecycle, or changes its claims, not when its
activity changes; peers with no recent heartbeat are counted in `+N more`
instead of listed, and unnamed sessions show their full instance id. The
Stop-enforced turn-ritual reminder appears on a session's first prompt, after a
compaction, and after a bounced turn. `agents status` prints a compact box
(task, lifecycle, files, peers, time) with diagnostic rows only when they
report a problem; `--full` prints every row.
