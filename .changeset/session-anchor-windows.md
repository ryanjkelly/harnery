---
"harnery": patch
---

On Windows, an agent's own pid-map anchor now verifies against the process start time, so a nested agent whose shells inherit another adapter's session id resolves to itself instead of to the session that spawned it. The owner lookup also stops treating a recycled Windows pid as the process that first recorded it.
