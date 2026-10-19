---
"harnery": patch
---

A resume lock left by a process on this host that has exited, or whose PID now belongs to a different process, no longer blocks `run resume` or `run reclaim`; it is retired automatically. `run unlock` and the digest-pinned `run reclaim --unknown-liveness --actor --reason` override are gone. To reclaim a run whose liveness evidence is missing or corrupt, pass `run reclaim --force --yes`; it still refuses active evidence and records one `reclaim_forced` event in the workspace ledger.
