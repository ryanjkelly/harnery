---
"harnery": patch
---

Fix several command and coordination bugs found in a code review:

- `grep --no-default-excludes` now disables the default skip list; the flag was parsed but never applied.
- `storage maintain --dry-run` now refuses to run with `--transaction` instead of executing the transaction anyway.
- `run` and `approval` next-step hints name the real commands (`run resume`, `run integration apply|prepare`, `run cleanup`, `approval approve`) instead of a nonexistent `workflow` command.
- `agents trace --since` reports an unsupported window instead of silently showing no events, and its text view no longer prints the JSON payload first.
- A journal entry body that contains a `## ` markdown heading is no longer dropped when the journal is rewritten.
- One malformed `.name-history` row no longer erases every agent's name binding.
- Resuming a workflow tolerates a torn last transcript line.
- The claim guard logs a failed claim read instead of swallowing it.
- Agent-facing hints from `init`, `work`, `doctor`, council messages, and the backup scheduler use the host's command name instead of a literal `harn`.
- `docs` git calls pass file names as arguments rather than through a shell.
- Removed unused internal functions.
