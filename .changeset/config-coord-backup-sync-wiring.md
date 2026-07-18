---
"harnery": minor
---

Honor the `coord`, `backup`, and `sync` config sections from `config.jsonc`, and add a user-global config layer.

Previously these sections were declared in the published JSON schema but the config reader never read them — freshness was env-only, `harn backup`/`harn sync` were env-and-separate-file only. Now:

- **User-global layer**: `~/.config/harnery/config.jsonc` (honors `XDG_CONFIG_HOME`) is read as a base and merged **project-over-user**, field by field. The `binName` pin that `harn init` guards stays project-file-only.
- **`coord.freshness_seconds`** drives the heartbeat sweep window and the `agents` freshness cutoff (env `HARNERY_AGENT_COORD_FRESHNESS`, alias `HARNERY_AGENT_FRESHNESS`, still override). This also unifies three previously-divergent reads (a hardcoded `600`, `AGENT_FRESHNESS`, and `AGENT_COORD_FRESHNESS`) onto one accessor.
- **`backup.{repo,password_file,keep_daily,keep_weekly,keep_monthly}`** set the restic defaults (env + `--keep-*` flags still override).
- **`sync.{remote,prefix}`** set the rclone defaults (env still wins; `~/.config/harnery/sync.json` remains a lower-precedence fallback).

Schema alignment: removed keys that described non-features (`coord.name_pool`, `backup.schedule`, `sync.enabled`, `sync.drive_folder`) and added the ones the code actually honors. A config that set one of the removed keys (all previously no-ops) now fails `$schema` validation.
