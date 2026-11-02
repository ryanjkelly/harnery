---
"harnery": minor
---

New `permissions` command and dashboard page: what the coding agents on this computer may do, read from each tool's own settings. It reports Claude Code's permission mode and allow, ask and deny rules from every settings file, Codex's effective approval policy, sandbox, project trust and hook trust (asked through `codex app-server`), Cursor's approval mode, sandbox and allow and deny lists, and every live desktop-control approval on the computer. Read-only; only permission fields are read back. The dashboard's `/permissions` page adds the computer-use status and a plain-language meaning for each value. Dashboard pages that run the CLI now start `bin/harn.mjs` with the runtime instead of the POSIX `bin/harn` script, and without the dashboard's `NODE_OPTIONS`, so they work on Windows.
