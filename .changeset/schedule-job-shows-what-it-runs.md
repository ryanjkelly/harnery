---
"harnery": minor
---

A Harnery job's schedule record now carries `job`: its gather commands (argv as written, environment variable names only), its judge agent with the full prompt, its enrollment state here, owner, limits and newest run. `harn schedule show` prints them in plain words. The separate `harnery` object on `schedule show --json` is removed; read `record.job` instead.
