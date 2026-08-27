---
"harnery": minor
---

`init` now excludes the `.harnery/` coord root from editor indexing: it appends a managed entry to `.cursorindexingignore` and merges `"files.watcherExclude": {"**/.harnery/**": true}` into `.vscode/settings.json` (creating either file when absent, and leaving a settings file it cannot merge safely untouched with a manual-step notice). `deinit` reverses exactly the managed pieces. Git-aware tools already skipped runtime state via `.harnery/.gitignore`, but Cursor's codebase indexer and the VS Code/Cursor file watcher do not read gitignore, so a busy coord root (tens of thousands of ledger events plus working artifacts) turned editor startup into an indexing storm on session-heavy hosts.
