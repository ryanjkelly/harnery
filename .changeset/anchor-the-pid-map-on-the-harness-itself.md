---
"harnery": patch
---

The pid-map now anchors on the adapter process, not on whatever shell happened
to run the hook.

Anchor selection recognised a adapter by the name of its binary, and one Claude
Code build installs its CLI under a version-numbered filename, so the ancestor
walk matched nothing. Callers then fell back to the hook's own parent shell,
which exits within seconds of being recorded. Every row for such a session was
dead almost immediately, the identity walk found nothing, and sessions resolved
as unattributed. It also meant a steady drip of dead rows, one per hook shell.

Two ways in. A adapter that exports its own pid is believed outright, which
Claude Code does. Failing that, the ancestor walk gets a second pass over
executable paths, matching whole path segments so an install directory
identifies a binary whose own name does not. The existing name match still runs
first, so this only ever adds matches.

Observed on the environment that prompted it: three live, correctly attributed
rows where there had previously been none, one per agent session.
