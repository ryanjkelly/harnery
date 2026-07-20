---
"harnery": minor
---

New `harn claude-desktop` command: make Claude desktop-app sessions survive account switches.

The Claude desktop app scopes its Claude Code session sidebar per signed-in account (plain JSON entry files under `<dataDir>/claude-code-sessions/<account-uuid>/<env-id>/`), so switching accounts — the usual move when one account hits its usage limit — hides every prior session even though the transcripts remain on disk. `harn claude-desktop accounts` / `sessions` enumerate the per-account indexes (auto-locating the data dir on macOS/Windows/Linux, including Windows-side discovery from inside WSL; labels the CLI's own account via `~/.claude.json`), and `harn claude-desktop mirror` copies entry files across account directories so each account's sidebar lists the union. Mirror is dry-run by default (`--yes` applies), idempotent (dedup by `cliSessionId`), skips archived entries unless `--include-archived`, selects with repeatable `--session <id-or-title>` / `--all`, and scopes direction with `--to` / `--from` uuid prefixes. Restart the desktop app to pick up mirrored entries.
