---
"harnery": patch
---

Recognize Codex Desktop's `CODEX_THREAD_ID` as a session identity source so
coordination commands resolve the correct heartbeat when tool processes cross
the Windows-to-WSL boundary.
