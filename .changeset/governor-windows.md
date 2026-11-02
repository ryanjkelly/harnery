---
"harnery": patch
---

Sealing a shared log segment no longer fails on Windows. Emptying the active file after a rotation opened it with `O_TRUNC` and no `O_CREAT`, which Windows rejects with `EINVAL`, so every rotated log family, including the governor service log, stopped at its first seal. The file is now opened for writing, checked against its parent directory, and then truncated through the open descriptor, so a path swapped in between is never emptied.
