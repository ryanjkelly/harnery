---
"harnery": patch
---

Pid-map rows now record which *run* of a pid they were written for.

A pid is a number the operating system hands back out. Measured on one
development machine: `pid_max` of 99999 against roughly 100 new processes a
second, so the whole space turns over about every quarter hour. Past that point
a row can name a pid an unrelated process now holds, and everything that trusts
the row inherits the mistake. `agents whoami` reports another agent's name and
file list. A departed agent still reads as live, so a commit guard treats its
claims as a live peer's and `identity assume` refuses to reclaim its name.

Sweeping dead rows does not reach this. The sweep removes rows whose pid has
exited; a recycled pid is alive, so the rows it removes are the harmless ones
and the row it keeps is the wrong one.

Each row now carries a start token alongside the instance and platform, and
every place that believes a row checks it: the sweep, the liveness query, and
both identity walks. The token is opaque and compared only for equality. Linux
reads start ticks from `/proc` with no subprocess, BSD pays one `ps -o lstart=`,
and a platform that will not say writes no token at all. Rows without one, which
is every row on disk today, keep behaving exactly as they did.

Also fixes platform parsing, which took everything after the first tab and so
would have swallowed the new field.
