---
"harnery": patch
---

On Windows, overwriting a ZIP retries briefly when a scanner or indexer still holds the previous archive open. The workspace provider's isolated Git now carries the system `core.autocrlf` as a minimal system config file, so a user's global or repository setting still takes precedence.
