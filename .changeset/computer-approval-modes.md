---
"harnery": minor
---

`computer` gains approval modes. `computer.mode` is `off`, `ask-each-task`,
`ask-once-per-session`, or `on` (`enabled: true` without a mode still means
`on`; a malformed or contradictory section counts as `off`). The project sets
the default; where it is not `off`, each person may choose their own with
`computer mode <mode>` (this project or `--all-projects`), stored in
`~/.config/harnery/computer.json`, and loosening it asks them first. In an ask
mode, `call` and `lease acquire` exit 4 until the agent runs
`computer grant --purpose "<text>"` and the person approves a Yes/No prompt
(terminal, or a native dialog on Windows, WSL, macOS, or a Linux desktop with
zenity); no answer counts as no. Task approvals last up to `grant_minutes`
(default 20) and end at `computer done` or `lease release`; session approvals
last until `computer revoke` or 12 hours. Decisions are logged beside the
lease. A call now holds the lease for at least the driver's call timeout, so a
slow call can no longer outlive it. The `harn-computer` skill teaches the
grant, work, done loop and the no-sending rule. New exports from
`core/config`: `ComputerMode`, `readComputerPreferences`,
`writeComputerPreference`, `computerPreferencesPath`.
