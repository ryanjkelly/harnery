---
"harnery": patch
---

Admission tickets now record the holder's process start time where Linux `/proc` is absent (macOS). A ticket whose pid is alive but belongs to a process that started at a different time is pruned as abandoned, so a crashed holder's reused pid no longer keeps a slot until the TTL. An unreadable start time still counts as the holder, and Linux keeps the plain pid check.
