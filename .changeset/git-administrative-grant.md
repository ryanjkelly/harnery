---
"harnery": minor
---

Add `EngineOpts.gitWrite`, a named grant for write access to a repository's Git administrative directory.

A workflow run that needs its children to commit can now set `gitWrite: "shared-repository"`. The engine resolves the concrete paths from the workspace binding the provider verified, appends them to the projected filesystem policy, and records the grant in run proof. The default is `"none"`.

The caller asks by name and never supplies the path. Caller-supplied `writableRoots` must still lie inside the workspace, so this grant is the only sanctioned way for a run to write outside it.

Two measurements shaped the design and are recorded in ADR 0040: in a linked worktree both halves of the administrative directory live outside the workspace root, and a commit needs the shared half, so no scoped version of the grant exists.
