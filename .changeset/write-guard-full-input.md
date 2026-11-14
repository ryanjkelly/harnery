---
"harnery": patch
---

Claim large writes. The pre-tool guard read file paths from the ledger's copy of a tool call, which is clamped to 8000 characters, so a Write, Edit, or Codex patch larger than that acquired no claim and skipped the peer-conflict check. The guard now reads the adapter's full tool input and accepts every Codex patch shape that line counting accepts.
