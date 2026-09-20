---
"harnery": minor
---

`harn init` wires a set of adapters instead of exactly one. `--adapter` is
repeatable, accepts comma-separated ids, and accepts `all`; with no flag, init
refreshes every adapter the project already has wired, falling back to
claude-code on a project with no wiring. `--instructions-only` keeps its
single-adapter scope.
