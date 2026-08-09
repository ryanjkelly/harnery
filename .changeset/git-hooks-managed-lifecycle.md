---
"harnery": minor
---

Git hooks join the managed lifecycle: `init` installs them, upgrades ride the package, `deinit` removes them

Coordination behavior in a consumer's git hooks used to be the consumer's
problem: hosts copied the staged-path collection, submodule canonicalization,
gitlink probe, verdict call, and claim-pruning shell into their own
`pre-commit` / `post-commit` / `post-checkout` files, and those copies sat
outside the upgrade path. The first host's copies decayed for months (one hook
had a recycled-pid guard the other two never got; all three shared an identity
blind spot) and even shipped calls to an `agent-coord log` subcommand that does
not exist. Nothing in `init`, `deinit`, or `--check` knew git hooks existed.

Now the whole surface is machine-owned, on the same contract as the AGENTS.md
instructions block:

- **`agent-coord git-hook <event>`** owns every piece of hook behavior
  in-process: staged/committed/checkout-removed collection (rename-aware,
  submodule-canonical, gitlink-discriminating, clean-in-worktree gating), the
  commit-conflict verdict, and claim pruning. Fail-open by design: an internal
  error never blocks a commit; a clean conflict verdict still does. A repo's
  root commit now prunes claims too (the bash era silently skipped it).

- **Hook files carry only a hash-versioned managed region**
  (`# harnery:begin git-hook-<event>` markers, the `#`-comment sibling of the
  Markdown region syntax) that locates `agent-coord` in either consumer layout
  (git submodule or node_modules) and invokes `git-hook <event>`.

- **`init` installs or refreshes the regions** (honoring `core.hooksPath` and
  worktrees via `git rev-parse --git-path hooks`): a missing hook file is
  created whole and executable; a host-authored hook gets the region inserted
  after its shebang, everything else untouched. **`init --check`** reports a
  missing or stale region as drift (exit 2). **`deinit`** removes the region,
  deleting only files harnery created whole.

`spliceRegion`/`removeRegion`/`checkRegion` accept an optional comment style
("html" default, "hash" for shell files); existing callers are unchanged.
