---
"harnery": patch
---

Hold ready Event V3 rows until their causal parents and attestation declarations are committed. This prevents concurrent re-onboarding from appending a dependent event before the event that mints its attestation.
