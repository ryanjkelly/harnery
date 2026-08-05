---
"harnery": patch
---

Add an ownership-aware `agents status --final` check that withholds the status
box until the current session's held paths, submodule pointers, and touched
repositories are committed and pushed. Released claims remain in scope through
the session's durable write-claim history, so a local commit cannot hide by
reducing the active file count to zero.

Submodule completion compares gitlink commit IDs directly, so unrelated dirty
files inside a peer's submodule working tree do not create a false block.
