---
"harnery": patch
---

Keep command telemetry joinable across a size-triggered V3 epoch rotation.
Rotation now uses the atomically archived producer directory to start a fresh
generation for every live session and to reopen any turn that was active at
the boundary. The successor therefore has joinable producer state before the
session's next adapter hook. Producer-state writes now carry the same epoch
fence as event writes, and an old-epoch hook that finishes after rotation
cannot overwrite the re-anchored state.
