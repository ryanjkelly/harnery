---
"harnery": patch
---

The shared cookie store no longer loses an update on Windows when another process is reading the store file at the moment it is replaced. Windows refuses to rename over an open file and reports `EPERM`; the cookie jar now retries that rename for up to 2 seconds (also for `EACCES` and `EBUSY`, on Windows only) before reporting the error. Other platforms and other errors behave as before.
