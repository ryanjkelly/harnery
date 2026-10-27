# Executables

| File | Purpose |
| --- | --- |
| `harn`, `agent-hook`, `agent-coord` | Existing Bash entrypoints for POSIX callers |
| `harn.mjs`, `agent-hook.mjs`, `agent-coord.mjs` | Node entrypoints used by npm on all platforms |
| `run.mjs` | Starts Bun source or the built Node bundle without a shell |

The native entrypoints preserve arguments, stdin, and the child exit code.
Source checkouts require Bun; the published package also includes `dist/`.
