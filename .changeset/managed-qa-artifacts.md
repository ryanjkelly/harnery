---
"harnery": minor
---

qa-run and qa-record now create isolated managed workspaces under
`.harnery/artifacts/` when `--out-dir` is omitted. The output participates in
artifact retention and byte budgets instead of leaking into the project source
tree. Explicit output directories are unchanged, and qa-status without a path
now finds the newest run across managed QA workspaces.
