---
"harnery": patch
---

Guard cross-root writes with explicit finalization roots. Projects that require
`agents status --end-turn` can authorize sibling Git repositories or deliberate
non-Git output roots in project config. The pre-use hook now rejects unsupported
targets before mutation, while the end-turn checker preserves durable released
claims and applies the normal dirty and remote checks to authorized sibling
repositories.
