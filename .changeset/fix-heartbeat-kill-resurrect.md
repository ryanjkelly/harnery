---
"harnery": patch
---

Stop killed and swept heartbeats from coming back on the next event drain. `claim.release` and `health.heartbeat_swept` no longer seed a heartbeat when no live file exists, sweep telemetry sets `ended_at` without refreshing liveness, and `kill-heartbeat` emits a `health.heartbeat_swept` (`reason: killed`) terminal marker before its claim releases.
