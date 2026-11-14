---
"harnery": minor
---

Add a machine-local config layer and a setting for remote peer detail. `.harnery/config.local.jsonc` is merged on top of the committed project file, field by field, so one machine can lower a project value; admission settings now read the project file plus this file. Values that guard a trust boundary stay project-only. `harn init` git-ignores the file when the host does not already, and `harn doctor` names the keys it overrides. `presence.remote_detail` (`full`, `summary`, or `off`; env `HARNERY_PRESENCE_REMOTE_DETAIL`) controls how much of other machines' sessions reaches agent context; `full` now caps remote rows at ten across all machines. The SessionStart peer table now folds stale and not-yet-named sessions into `+N more` and never prints `agent-unknown`.
