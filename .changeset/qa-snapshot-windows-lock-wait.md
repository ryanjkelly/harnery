---
"harnery": patch
---

The page review snapshot store now waits for a lock folder that is being removed on Windows instead of failing. Windows reports `EPERM` when a process creates the lock folder while another process is deleting it; the writer now treats that like an existing lock and retries until the usual five-second deadline, after which it still fails closed. Other platforms still treat `EPERM` as a real permission error.
