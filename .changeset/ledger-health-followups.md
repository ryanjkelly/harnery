---
"harnery": minor
---

Route native subagent tool hooks through their session owner's V2 generation,
classify commands without an open turn as unjoinable rather than rejected, and
make `agents health` separate current failures from historical diagnostics.
Active-agent health now follows V2 ledger generations instead of disposable
legacy heartbeat caches after cutover.
