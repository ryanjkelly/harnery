---
"harnery": patch
---

Fix: `agents set-task` / `release-claim` / `stamp-status-call` / `heal` failed with "no heartbeat at .harnery/active/<id>.json" when the shell's cwd sat inside a nested directory carrying its own `.harnery/` (e.g. an embedded harnery checkout). The parent command resolves the coord root git-superproject-aware, but the spawned `agent-coord` helper re-resolved by walking up from the drifted cwd and hit the nested root. Every agent-coord spawn now pins the caller-resolved root via `HARNERY_COORD_ROOT_OVERRIDE` (the same contract the hooks side already used), and the no-heartbeat error names the fully-resolved path so a wrong root is instantly visible.
