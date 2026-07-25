---
"harnery": patch
---

Tell an operator *why* an attempt's journal could not be read. `work show` now
renders the recorded reason next to a `journal_unreadable` attempt instead of the
bare status. The reason is whitespace-normalised and truncated for the human
render so a long or multi-line error cannot break the one-line-per-attempt shape
of the `attempts:` block; `--json` still carries the full value.
