---
"harnery": minor
---

Allocate isolated workspaces from linked worktrees and submodule checkouts, not
just plain repositories. `inspectSourceRepository` refused any checkout whose
`.git` was not a real directory, which rejected the four shapes whose `.git` is a
`gitdir:` pointer file — a linked worktree, a submodule checkout, a worktree of a
submodule, and the submodule this package is embedded as — even though `git
worktree add` supports all of them. The directory check was a shortcut for a
property: that the provider can name every path git will write to, each inside the
declared writable root, each covered by `allowed_paths`, and each provably the
authority git itself uses. That property is now proven directly — resolve `.git`
(directory or pointer file, symlink still refused), require it to equal `rev-parse
--git-dir`, and assert the git dir sits inside the common dir — so the containment
and `allowed_paths` checks that were trivial in the plain layout become
load-bearing in the others.

Three coupled fixes follow: the repository lease keys on the Git common directory
alone, so several checkouts sharing one admin area (a superproject and its
worktrees; a submodule and a worktree of it) serialize their `worktree
add`/`prune`/shared-`config` writes instead of racing under different lease keys;
`probe` now refuses a layout whose authority no declared writable root covers,
naming the common directory rather than reporting supported and failing later at
`allocate`; and integration apply re-authorizes the common directory against
`allowed_paths`, since a submodule fast-forward moves a ref outside the checkout
tree. See ADR 0045.
