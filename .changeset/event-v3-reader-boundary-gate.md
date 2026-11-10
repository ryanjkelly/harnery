---
"harnery": patch
---

Event V3 recovery and history now take ledger locations and catalog checks from their owning modules, so the one-reader gate passes and runs in `check:local core`. Importing archived ready events validates sealed segments through the new `verifyRetainedSealedSegmentsV3` in `core/events/v3/catalog`, and the epoch cutover drains ready records through the writer's new `drainReadyEventsHeldLeaseV3`. Behaviour and error messages are unchanged. The gate now also catches the path-segment spelling of the ledger location.
