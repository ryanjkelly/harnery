---
"harnery": patch
---

Make cold ledger reads and command recording cheaper. A process with no cached read now trusts the authenticated validation checkpoint that writers already keep, when it names exactly the storage being read: it skips the per-event contract and canonical-byte checks, still applies every ledger-level rule, and keeps the result only if it reproduces that checkpoint exactly. Anything else falls back to full validation. A full read of a 23 MB active segment drops from about 430 ms to 90 ms with an identical result. Command output summaries are now staged durably and appended together with the command's completion under one lease.
