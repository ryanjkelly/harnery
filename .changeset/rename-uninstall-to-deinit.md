---
"harnery": minor
---

feat(deinit): rename `harn uninstall` to `harn deinit`

The project-unwire command is now `harn deinit`, the inverse of `harn init` (the
same pairing `git submodule deinit` uses). Behavior is unchanged: it removes
harnery's hook entries from the harness settings file and, with `--purge-state`,
the `.harnery/` coord root.

The rename resolves a scope collision introduced when the hosted `uninstall.sh`
shipped. "uninstall" now means exactly one thing, removing the CLI from the
machine (`curl -fsSL https://harnery.com/uninstall.sh | bash`, or
`npm rm -g harnery`), while project wiring is `init` / `deinit`. Pre-1.0, so this
is a clean break with no alias; `harn uninstall` no longer exists. `scripts/teardown.sh`,
the `harn doctor` drift nudge, and the docs are updated to match.
