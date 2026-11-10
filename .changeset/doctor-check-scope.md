---
"harnery": minor
---

`harn doctor` now gives every check a `scope`: `runtime` when Harnery runs on or uses it, `environment` when it describes the machine only. The `node` check is `runtime` on Node.js and `environment` on Bun, where it inspects the `node` on PATH; `python3` is also `environment`. A project can set `doctor.environmentFindings` to `"report"` in `.harnery/config.jsonc` (project config only) so that failing environment checks still print and stay in `--json` but exit 0 when no runtime check fails. A failing runtime check always exits 1, and the default (`"fail"`) is unchanged. `--json` adds `scope` to each check, `summary.runtimeFail` and `summary.environmentFail`, and top-level `environmentFindings` and `outcome` (`pass`, `reported` or `fail`).
