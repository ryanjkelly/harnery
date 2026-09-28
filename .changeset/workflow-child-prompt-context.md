---
"harnery": patch
---

Headless workflow children (`HARNERY_WORKFLOW_CHILD=1`) no longer receive prompt-time coordination context or a pool name. Previously only SessionStart context and the Stop rule honored the flag, so a child was told to name itself and follow the end-of-turn ritual, registered as a named peer, and drained mail held for that dormant name. The prompt hook now returns no context for a child, session-start and turn-start naming skip it, and the session-name display prompt and gate do not apply.
