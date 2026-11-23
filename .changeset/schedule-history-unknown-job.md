---
"harnery": patch
---

`harn schedule history <id>` now refuses an id that is not in the job file and has no recorded runs (`schedule_unknown_job`), where it used to print "No runs recorded" and exit 0. A removed job's runs are still listed, with a line saying the job is no longer defined. The `--json` output gains `defined` (`true`, `false`, or `null` when the job file cannot be read).
