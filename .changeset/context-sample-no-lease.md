---
"harnery": patch
---

Context samples recorded by hooks no longer take an fsync'd per-session lease. A changed sample now costs 11 file system calls instead of 48, and an unchanged one 5 instead of 42. Recovery completion stays bound to its prepared checkpoint (session, task instance, generation and capsule ID) and uses compare-and-write, so a checkpoint that lands mid-completion is never overwritten. The checkpoint token no longer carries a capsule digest.
