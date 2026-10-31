---
"harnery": minor
---

`grep` no longer bounds result rows by default; `--all` is removed. Every
default tried from 50 to 300 rows dropped evidence that an unbounded search
found, so a search shows every row unless `--limit <n>` sets a page size.
Paging, the count pass, and the "left out" line with the `--page` that
continues are unchanged. `--page` now needs `--limit`. Lines are still clipped
to 300 characters by default (`--max-columns`).
