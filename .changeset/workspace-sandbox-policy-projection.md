---
"harnery": minor
---

Project the host's filesystem policy into a harness's own vendor sandbox.

`SpawnRequest` gains an optional `filesystemPolicy` carrying a mode
(`read-only` or `workspace-write`) and an explicit set of writable roots. Each
harness profile declares what it can represent, and an adapter that cannot
represent a requested projection refuses before launch rather than silently
falling back to the vendor default.

This closes a gap where a child in a provider-owned Git worktree could edit
files but not commit. The vendor excludes a repository's administrative
directory from its writable set by policy rather than by path, so no repository
topology avoids it; naming the directory as a writable root does. Verified end
to end against the real CLI.

Of the three built-in adapters, only `codex` can carry a projection today.
`claude-code` and `cursor` declare it unrepresentable and refuse. Requests
without a `filesystemPolicy` are unchanged, so shared-checkout runs behave
exactly as before.
