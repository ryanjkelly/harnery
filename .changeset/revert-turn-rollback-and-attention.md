---
"harnery": patch
---

Removes two 0.45.0 additions that nothing needed. The per-turn content rollback command and its `./core/turn-rollback` export are gone; no hook, command or workflow called it (ADR 0216, withdrawn). Dashboard tabs alert on their own again instead of electing one recipient through `/api/attention`, which wrote a file per tab every 2 seconds and silenced every tab when the request failed (ADR 0217, withdrawn).
