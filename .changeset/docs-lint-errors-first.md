---
"harnery": patch
---

`docs lint` now lists error violations before warnings in its report. In a
repository with thousands of advisory warnings, the error that fails the run
used to sit deep inside the list, past where a truncated or skimmed output ends.
