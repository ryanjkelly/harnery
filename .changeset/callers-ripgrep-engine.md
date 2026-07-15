---
"harnery": patch
---

`harn callers` now shares the ripgrep engine + provisioning path with
`harn grep` (ripgrep when available, GNU grep fallback, `HARNERY_GREP_ENGINE`
override, managed-install consent) and searches repos in parallel. Fixes the
same double-scan bug grep had: in `--all-repos` mode the parent scan now
prunes submodule directories, so each match is attributed to exactly one repo
instead of being reported under both parent and submodule. Engine parity is
pinned by a new test suite.
