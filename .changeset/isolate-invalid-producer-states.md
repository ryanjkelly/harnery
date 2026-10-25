---
"harnery": patch
---

Validate a V3 producer state with the reader's own validator before publishing it, so a state no reader would accept fails in the hook that produced it and the previous file stays in place. One invalid producer-state file no longer fails every listing in the checkout: listings skip it and record a `producer_state_invalid_skipped` diagnostic naming its adapter and session hash, `agents health` and `ledger-v3 status` report it by name, and readers that target that session's own state still fail closed. Pending runtime contexts reconciled past the retry limit by an externally driven retry are now readable.
