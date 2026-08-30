---
"harnery": minor
---

Bound V3 event-ledger epochs with automatic size rotation and an epoch fence on writes.

Every canonical read validates the complete epoch, and hook producers are one-shot processes, so an unbounded active segment made each hook's cold read scale with all recorded history (memory and latency grew without limit). The route boundary now rotates a valid active epoch into `.harnery/ledgers/v3-archives/` once `active.ndjson` reaches a threshold (default 32 MiB; `events.rotate_active_bytes` in `.harnery/config.jsonc` or `HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES` override it, `0` disables). The replaced epoch archives whole and unmodified; live sessions re-onboard into the successor on their next signal.

Because producer boot sequences must start at 1 and causal links must resolve inside their own epoch, writers gained an epoch fence: producers stamp events and producer state with the genesis id they were built against, the writer refuses (`epoch_replaced`) or quarantines (`.epoch-replaced` beside the spool) anything produced for a replaced epoch, and stale producer state is never adopted across an epoch boundary. `LiveEventLedgerRouteV3` now carries `genesis_id`, and `publishAuthorityTransactionV3` / `reconcileAuthorityTransactionV3` accept an optional epoch fence.
