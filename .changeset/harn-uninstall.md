---
"harnery": minor
---

Add `harn uninstall`, the inverse of `harn init`. Removes only harnery's own hook entries from the harness settings file (`.claude/settings.json` / `.cursor/hooks.json` / `.codex/hooks.json`), preserving any other hooks and non-hook settings, and deletes the settings file when it's left harnery-only. Keeps the `.harnery/` coord root by default; `--purge-state` deletes it (and the `binName` stamp) too. Idempotent, harness-agnostic in what it strips, and supports `--dry-run` / `--project-root`. Exposes a pure `unwireHooks()` (inverse of `wireHooks()`) for testing.
