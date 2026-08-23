---
"harnery": patch
---

Skip semantic service passes when every matured pending generation is still inside its per-generation call cooldown, while preserving the pass that records deferred work at the hourly cap.
