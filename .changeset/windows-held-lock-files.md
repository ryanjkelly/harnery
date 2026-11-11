---
"harnery": patch
---

The cookie store lock, the identity assume lock, the singleton service lease, the workflow resume lock, the command guard's evaluation lock and the semantic service lease now treat `EPERM` from an exclusive lock file create on Windows as a held lock, so a writer waits, reports busy, or checks the current owner while another process is still deleting the lock file, instead of failing with `EPERM`. The semantic service lease also no longer fails when the stale lease it is replacing has already been deleted. Other platforms still fail on `EPERM`.
