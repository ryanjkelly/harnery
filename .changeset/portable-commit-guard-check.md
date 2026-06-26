---
"harnery": patch
---

fix(coord): make the commit-guard wiring check portable (drop host-specific paths)

The SessionStart "coordination hooks are NOT wired" check baked two
host-specific assumptions into the published package — a leak from when the
coord layer was extracted from its origin monorepo and the bash UX was ported
to TS verbatim:

- It hardcoded the git-hooks location as `<root>/scripts/hooks` and compared
  `core.hooksPath` against it, so any host using a different convention (or the
  default `.git/hooks`) got a false "NOT wired" warning even when the guard was
  correctly installed.
- The remediation told every host to run `scripts/setup-hooks.sh`, a script
  that only exists in the origin repo.

The check now asserts the *functional* property instead of a path convention:
it resolves each repo's effective hooks dir via `git rev-parse --git-path hooks`
(which already honors `core.hooksPath`, worktrees, and submodule gitdirs) and
verifies the `pre-commit` there actually invokes `agent-coord` / `agent-hook`.
The remedy command is host-supplied via a new optional `hooksSetupHint` field in
`.harnery/config.jsonc` (read through `resolveHooksSetupHint`); unset → a
generic, host-agnostic message. harnery doesn't install git hooks itself, so the
"how to fix it here" string belongs to the host, the same way `binName` does.
