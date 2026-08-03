---
"harnery": patch
---

Stop the pre-commit guard blocking a session against its own commit, which had
made `HARNERY_AGENT_COORD_BYPASS=1` routine even though that flag also disables
the genuine conflict check.

The read-only git probes behind the self-attribution gates now run with git's
repository-discovery environment scrubbed. A git hook exports `GIT_DIR` and
`GIT_WORK_TREE`, children inherit them, and they outrank `cwd`, so every probe
questioned the repository being committed rather than the one owning the path it
asked about. Those probes also now run from the path's own directory, so a claim
recorded monorepo-relative resolves against the repository that actually tracks
it at any nesting depth, and a git-ignored path no longer counts against the
holder, since an ignored path cannot enter anyone's commit.

Also bounds the pid-map. Rows are written per hook shell, those shells exit
immediately, and nothing pruned them, so the map only grew. Stale rows are not
only clutter: pids get recycled, and an identity walk that lands on a reused pid
resolves to a long-gone agent. Writes now sweep dead rows once the directory
passes 200, liveness treats `EPERM` as alive instead of counting another user's
process as gone, and the hook path calls the shared writer rather than its own
copy, so the sweep reaches the only hot write path in the system.
