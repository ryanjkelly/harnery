---
"harnery": patch
---

Stop Cursor session-name loops by recording exact title blocks from
`afterAgentResponse` and by treating later `preToolUse` narration as unavailable
rather than proof that the earlier title response was missing.
