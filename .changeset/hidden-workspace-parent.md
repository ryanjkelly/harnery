---
"harnery": minor
---

Isolated workspace checkouts now allocate under `<writable-root>/.harnery-workspaces/`
instead of the visible `harnery-workspaces/`, and the provider writes a
`.gitignore` containing `*` into that parent on first allocation. The rule covers
the ignore file itself, so the directory no longer appears in `git status` and
consumers do not have to add an ignore rule by hand.

The parent stays a sibling of `.harnery/` rather than moving inside it, because
`harn deinit --purge-state` deletes `.harnery/` recursively and that directory can
hold a preserved worktree with unintegrated work.

Existing bindings keep the path they froze at allocation time. Reconciliation and
retries follow the recorded parent, so a workspace created under the old name
still reattaches, integrates, and cleans up.
