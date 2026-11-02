---
"harnery": patch
---

Fix the shared log rotation lease on Windows. Releasing the lease no longer fails silently when another writer is reading its owner record, which left the lease held and made every later writer time out. A claim now takes over an empty lease directory left by an interrupted writer, and a lease path that is a file or symlink fails closed instead of being replaced.
