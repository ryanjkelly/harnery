---
"harnery": patch
---

`init` now installs its Git hook regions in each checked-out first-level submodule as well as the project, and `init --check`, `doctor` and `deinit` cover them too. A commit made inside a submodule runs that submodule's own hooks, so before this the commit guard and claim pruning never ran there, and the session-start wiring warning told people to run `init`, which did not fix it. A submodule whose `core.hooksPath` already points at the project's hooks folder counts once. The wiring check also accepts an absolute `core.hooksPath` on Windows (`C:/...`); it used to treat that path as relative and report the guard as missing.
