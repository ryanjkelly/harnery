---
"harnery": patch
---

More of Harnery runs on native Windows:

- Headless runs and workflow spawns start CLIs that npm installed as `.cmd` launchers (`codex`, `cursor-agent`, often `claude`). Node and Bun refuse to spawn a batch file without a shell, so Harnery reads the script an npm launcher runs and starts it with Node directly, with no `cmd.exe` quoting of prompt text. Other batch launchers get a clear error instead of `spawn EINVAL`.
- Host prompt-context providers can run on Windows. Windows cannot start the extensionless `scripts/hooks/harness/extensions/prompt-context`, so there Harnery looks for `prompt-context.exe`, then `prompt-context.mjs` or `.js`, which it runs with the hook's own runtime.
- The workspace provider's isolated Git keeps the system `core.autocrlf` on Windows, so a normal Git for Windows checkout no longer looks modified.
- Server port allocation sees listening ports on Windows (from `netstat`) instead of none, so it no longer hands out a port that is in use.
- Imported Claude desktop sessions remap Windows home paths that continue with `\`.
