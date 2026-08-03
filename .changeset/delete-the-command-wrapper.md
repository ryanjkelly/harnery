---
"harnery": minor
---

Delete the command wrapper.

`harn session "<intent>" -- <cmd>` ran one shell command, forwarded its output, and emitted `command.start` / `command.output` / `command.end`. It is gone.

Two things made it removable. Bare commands have been captured canonically for months: the PostToolUse tap emits `tool.pre_use` / `tool.post_use` carrying the same declared intent, so wrapping was already documented as optional for its main use case. And nothing reads `command.output` programmatically — the four references in the tree are the schema union member, two display-side name mappings, and the emitter itself. No logic branches on it.

What made it worth removing rather than leaving alone is that the slot could not be named. Blind naming panels rejected two different candidates for two different reasons: one collided with the command that runs a bounded execution, the other was unreadable to two thirds of first-time readers and drew the strongest confusable pair in the whole command set against the checkpoint command. A name that fails twice against two different neighbours is usually reporting a scope problem rather than a vocabulary problem.

The residual loss is real but narrow: long-running commands no longer stream per-line into the live viewer. Everything a run did is still on the ledger, one event at each end instead of one per line.

The retired no-op subcommands (`tail`, `clear`, `path`, `trim`) go with it. `trim` existed so an older SessionStart hook would not error; no shipped hook calls it now.
