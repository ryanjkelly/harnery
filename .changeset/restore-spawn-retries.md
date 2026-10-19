---
"harnery": patch
---

Failed agent launches retry again. Since 0.44.0 a rate limit or provider error ended the agent on its first attempt and charged the work budget, because retries required no-effect evidence that no adapter can produce. A failed spawn now retries unless the binary is missing, and a run that failed only on missing binaries or provider errors is uncharged (ADR 0221, superseding ADR 0213).
