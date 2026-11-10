---
"harnery": patch
---

The cookie store lock and the identity assume lock now treat `EPERM` from an exclusive lock file create on Windows as a held lock, so a writer waits (cookie store) or reports busy (identity assume) while another process is still deleting the lock file, instead of failing with `EPERM`. Other platforms still fail on `EPERM`.
