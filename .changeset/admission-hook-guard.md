---
"harnery": minor
---

The agent hook queues heavy shell checks for an admission slot when `admission.guard.resource` is configured, rewriting each typecheck, full test suite, or build segment into `admission run` for Claude Code and Codex. It also denies `git commit-tree`, which builds a commit that skips the index lock and pre-commit checks; `HARNERY_ALLOW_COMMIT_TREE=1` overrides.
