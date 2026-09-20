---
"harnery": patch
---

Move per-adapter hook behavior out of the hook CLI and the V3 producer into
one module per adapter under `src/core/hooks/adapter/behaviors/`. Session-start
labels, sound and journal effects, prompt-context nudges, transcript discovery,
the Codex WSL bridge, and runtime-context retries are now looked up by adapter
id instead of decided by scattered equality checks. Event payloads, the ledger
schema, and capability digests are unchanged.
