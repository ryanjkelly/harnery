---
"harnery": patch
---

Add an ownership-aware `agents status --final` check that withholds the status
box until the current session's held paths, submodule pointers, and touched
repositories are committed and pushed.
