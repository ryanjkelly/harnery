---
"harnery": patch
---

Fix: canonical emits silently vanished when the shell's cwd sat inside a nested directory carrying its own `.harnery/` (e.g. an embedded harnery checkout). `emitCanonical` resolved its root by walking up from cwd, hit the nested root, and built a `<root>/harnery/bin/agent-coord` path that doesn't exist — so `agents status` / `set-task` / scratch / presence / decision events were dropped without a trace, and the Stop-hook's rule 1/3 (`state.status_checked` in-turn) blocked turns that had performed the ritual. Root resolution is now git-superproject-aware (`monorepoRoot()`, with the cwd walk kept as a non-git fallback), the spawn pins `cwd` + `HARNERY_COORD_ROOT_OVERRIDE` to the resolved root (same contract as the coordHelperOpts root-pin fix), and a failed emit now warns on stderr instead of dying silently. `sessionEventsPath()` and `readLastIntent()` ride the same resolver, so middleware command events and intent stamps stop mis-anchoring to nested roots too.
