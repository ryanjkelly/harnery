---
"harnery": patch
---

Recover dead local artifact-lock owners, limit automatic cleanup slices, and
distinguish interrupted attempts from completed sweeps. Remind agents to retain
or discard reviewed evidence when releasing artifacts.

Require boot-scoped process tokens for PID-reuse recovery; wall-clock process
start times never justify removing a live PID's lock.

Release an initializing lock when writing its owner record fails, including a
partially written record.
