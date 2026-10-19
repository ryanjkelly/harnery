---
"harnery": patch
---

The workflow resume lock now lives in its own module, so the dashboard's read-only work and codec readers no longer load process-identity code that can spawn `ps`.
