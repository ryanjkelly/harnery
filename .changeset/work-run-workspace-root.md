---
"harnery": minor
---

Let a durable-work attempt run in an isolated workspace. `harn work run` and
`harn work retry` accept `--workspace-root`, matching `harn workflow run`, and
build the local Git worktree provider from it.

Before this, `--isolation worktree` was accepted and validated on `work run` but
could never be honoured: the command never constructed a workspace provider, so
every attempt fell back to shared. The fallback was recorded in the proof as
requested versus effective isolation, but the human output said nothing, so an
operator who asked for isolation on the durable-work surface got a shared run and
no indication of it. That surface is the one a project is handed to, which is
exactly where isolation matters.

Both attempt entry points take the flag, so a retry after a blocked isolated run
does not quietly drop back to shared. On resume the root is checked against the
frozen binding rather than replacing it. `--workspace-root` without
`--isolation worktree` is now refused instead of ignored, and a run that requested
isolation but allocated none reports that on the success path rather than leaving
it in the proof for nobody to read.
