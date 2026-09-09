---
"harnery": patch
---

Keep delayed Codex context observations on their original hook producer sequence
during approved session shutdown. This prevents finalization from introducing a
producer sequence gap that makes the shared event ledger unavailable.
