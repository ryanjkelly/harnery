---
"harnery": patch
---

Session-name gating now treats a readable transcript that omits the name-mint
tool result as unavailable evidence. Adapters with assistant-only transcripts
fail open instead of rejecting every later tool, while a transcript that
contains the mint followed by a malformed first reply still denies the tool.
