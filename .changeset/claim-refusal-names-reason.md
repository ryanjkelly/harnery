---
"harnery": patch
---

A refused file claim now names the coordination ledger's actual refusal reason (for example `heartbeat_missing`) instead of the generic "V3 authority is unavailable", and records a `claim_authority_refused` diagnostic. A regression test confirms a Claude Code session with no open turn can still acquire a claim.
