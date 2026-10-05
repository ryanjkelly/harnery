---
"harnery": minor
---

A project can now route Windows-native Codex hooks through a resident WSL bridge by setting `hooks.codexWindowsBridge.entryPoint` in `.harnery/config.jsonc` (project config only). `harn init` then writes a `commandWindows` on each Codex hook that runs the named command when it is on `PATH` and the working directory is a WSL path, and the usual command otherwise; removing the setting removes the field, and `harn doctor` reports a missing, different, or unexpected `commandWindows` as stale. The value must be a plain command name. Codex hooks now also leave a start marker under `.harnery/active/hook-runs/` that is removed on completion, and a new `codex:hook runs` doctor check reports runs from the last 24 hours that never finished, which is what a hook Codex killed at its timeout looks like. A `codex:Windows hook route` check reports the opt-in. See decision record 0197.
