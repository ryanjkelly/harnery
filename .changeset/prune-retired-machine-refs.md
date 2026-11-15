---
"harnery": minor
---

Add `presence refs` to inspect cross-machine presence, mail, and docket refs on origin, and `presence refs prune` to preview retiring refs older than 30 days. Explicit deletion protects this machine's refs, recent commits, unreadable mail, and undelivered messages unless mail deletion is requested. Each exact deletion checks that its inspected commit is still current, reports failures, and continues. Presence fetches remove local copies of refs deleted from origin.
