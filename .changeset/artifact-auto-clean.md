---
"harnery": minor
---

Expired artifact workspaces are now swept automatically. The first session start of each day runs the same guarded deletion as `artifacts clean --yes` (only `managed-expired` entries, each re-classified immediately before removal; unmanaged and legacy directories are never touched), throttled by a stamp file at `.harnery/artifacts-auto-clean.json` that also records the last run's result. Retention previously depended on someone remembering a manual command, so expired workspaces accumulated indefinitely on busy hosts. Disable with `artifacts.auto_clean: false` in `.harnery/config.jsonc` or `HARNERY_ARTIFACT_AUTO_CLEAN=0`.
