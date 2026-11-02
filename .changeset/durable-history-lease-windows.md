---
"harnery": patch
---

The durable history lease (mailboxes, approvals, name history and other append-only records) no longer jams on Windows. Like the log segment lease, an empty lease left by an interrupted claim is removed instead of blocking every writer, a lease that is not a directory fails closed, and a release blocked by a reader's open file is retried instead of silently leaking the lease.
