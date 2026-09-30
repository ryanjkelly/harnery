---
"harnery": patch
---

When a session is still live but the event ledger withholds its authority, `agents set-task`, `agents status`, `agents lifecycle`, and `agents heal` now name the blocking diagnostics and the events behind them. Previously they reported `heartbeat_missing`, `no_live_generation`, or `authority_missing`, and the first two suggested `agents lifecycle active`, which only reopens an ended generation and cannot help a live one. The messages now say so and point at `agents health`. Sessions that really ended still get the reopen hint.
