---
"harnery": minor
---

`grep` now bounds its output. A search shows at most 50 result rows unless
`--limit <n>` or `--all` is given, and clips each line to 300 characters
(`--max-columns <n>`, `0` for no clipping). When rows are left out, a count
pass supplies the totals and the last line states the matches and files left
out and the `--page <n>` that continues. Pages are cut from one sorted order,
so consecutive pages never repeat or skip a row and both engines select the
same rows. The `--json` envelope adds `limit`, `page`, `available_matches`,
`available_files`, `omitted_matches`, `omitted_files`, and `next_page`, plus
`clipped` on a clipped row.
