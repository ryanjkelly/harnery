---
"harnery": patch
---

`syncClaudeSessions` now resolves the host CLI bin via `resolveBinName()` instead of a hardcoded literal, so the Claude-Code session-telemetry sync fires for any consumer regardless of its bin name (previously it silently no-op'd unless the bin matched the previously-hardcoded name). The scratchpad UI-edit audit marker is now host-agnostic ("edited via UI by the operator") rather than naming a specific operator.
