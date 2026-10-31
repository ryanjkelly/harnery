---
"harnery": minor
---

`grep` now clips printed lines at 500 characters by default instead of 300.
On the context bench's v2 tune split, a 300-character clip cut a line that
held an answer, and 500 kept every claim the unclipped search found while
still roughly halving the output. `--max-columns <n>` and `--max-columns 0`
work as before.
