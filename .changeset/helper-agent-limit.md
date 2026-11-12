---
"harnery": minor
---

A helper limit for Claude Code helper agents and `harn run` workers: the most expensive model and the highest effort a helper may use.

- Set it with `harn devtools helpers` (for example `harn devtools helpers opus medium`, `none`, or `--clear`) or on the dashboard's Tools page. Your choice covers all your projects, and a project can commit a default under `helpers` in `.harnery/config.jsonc`.
- A Claude Code plugin applies the limit to each helper's model request; `harn devtools helpers --install` and `--uninstall` manage it. Installing adds one `CLAUDE_CODE_PLUGIN_DIRS` entry to the `env` block of each Claude Code user settings file and leaves every other byte as it was; uninstalling takes only that entry out. When the plugin cannot read your preferences file, it leaves helper requests unchanged rather than guessing. Run workers on Claude Code are lowered by the run engine.
- A machine-wide count of what helpers ran on, kept seven days, is shown in the report, with whether the limit is active and what it covers. `--format json` returns the same report.
