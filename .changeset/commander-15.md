---
"harnery": patch
---

Upgrade `commander` from 13 to 15. No change to harnery's public API or command surface; the full test and integration suite passes unchanged. Hosts that compose `createHarneryProgram` and rely on `instanceof CommanderError` should be on commander 15 too, so the thrown error matches across the package boundary.
