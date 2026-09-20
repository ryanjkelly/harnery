---
"harnery": minor
---

`harn init` wires a set of adapters instead of exactly one. `--adapter` is
repeatable, accepts comma-separated ids, and accepts `all`. With no flag, init
wires every adapter whose CLI is installed on the machine, plus every adapter
the project already has wired; a machine with neither falls back to
claude-code. `--instructions-only` keeps its single-adapter scope.
