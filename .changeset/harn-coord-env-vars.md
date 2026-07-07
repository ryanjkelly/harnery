---
"harnery": patch
---

The harness-probe helper (`harn agents probe` machinery) set and read stale host-prefixed coordination env vars that core no longer honors, so its `TEST_ANCHOR_PID` / root-override / off-switch overrides silently never applied. Aligned them to the `HARNERY_`-prefixed names core reads via `coordEnv()` — the probe now exercises the same env contract as the live hot path.
