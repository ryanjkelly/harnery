---
"harnery": minor
---

Observe model effort and speed from native runtime signals. `readRuntimeTuning` reads the newest Codex `turn_context` row (effective per-turn reasoning effort, including overrides) and the newest Claude Code assistant transcript row (model, effort, and usage speed from the same row). `scanTranscriptRuntime` replaces `scanTranscriptModel`, returning the paired model + tuning values. The V3 runtime attestation gains a `tuning` observation populated at session start, refreshed via `session.attestation_changed` when the observed value moves, and rendered on the codec card.
