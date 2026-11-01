---
"harnery": minor
---

Add the project-only `hooks.portableCommands` setting. When it is `true`, `harn init` writes `agent-hook <event> --adapter <adapter>` from `PATH` as every adapter hook command on every OS, adds the same command as each Codex `commandWindows`, and `init --check`, `harn doctor` and the session-start drift nudge treat that form as current everywhere. A project that commits its adapter settings and is cloned on Windows, Linux, WSL and macOS keeps one committed form. Projects without the setting are unchanged.
