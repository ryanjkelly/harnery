---
"harnery": patch
---

The governor service, local supervisor and legacy resource observer now share one owner check, one singleton lease, one stop request and one build-status comparison. A failed process probe now reports the governor's generation as unknown, the same as the other two services, and the start refusal wording is the same for all three.
