---
"harnery": patch
---

The V2 coordination recorder now completes a stale pending transaction left by a crashed writer instead of refusing every subsequent mutation. Hook observations are one-shot, so a pending entry whose owner died between the durable apply and the bookkeeping clear could never be retried by its own source, wedging the authority permanently. When the idempotent outbox can still settle the stale transaction (receipt present, or the ready record reconciles cleanly), the recorder finishes the bookkeeping and processes the new observation; a pending mutation that cannot be settled is still refused rather than guessed at.
