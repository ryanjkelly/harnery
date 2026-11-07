---
"harnery": patch
---

Probe process liveness through two shared helpers instead of twenty private copies. Lock, lease and admission-slot owners recorded with a process id of 0, a negative id or a non-integer now count as gone, so a corrupt owner record can no longer hold a lock forever. Tunnel and presence-relay status now count a process owned by another user as running.
