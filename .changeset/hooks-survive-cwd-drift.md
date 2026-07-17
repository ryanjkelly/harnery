---
"harnery": minor
---

Hooks now survive the session shell `cd`-ing away from the project root.

Harnesses spawn hook processes with the session shell's current working
directory, which follows `cd` into subdirectories, submodules, or off-repo
scratch dirs. Two failure modes stemmed from that:

1. **Silent spawn failure.** `harn init` wired hook commands with a
   project-root-relative agent-hook path (`bash harnery/bin/agent-hook …`),
   so once the shell left the root the hook binary wasn't found and every
   hook died silently — no events, no image capture, no claim guards, until
   the shell happened to `cd` back. Claude Code commands are now anchored on
   the harness-provided project dir
   (`bash "${CLAUDE_PROJECT_DIR:-.}"/…/agent-hook …`); re-running `harn init`
   upgrades previously-wired stale commands in place (new `upgraded` counter).
2. **Wrong coord root.** When the hook did spawn, `findCoordRoot` walked up
   from the drifted cwd and could land on a nested `.harnery/` (a submodule
   initialized with `harn init`) or none at all. The hooks-side resolver now
   prefers the harness project dir (`CLAUDE_PROJECT_DIR`) over the cwd walk;
   `HARNERY_COORD_ROOT_OVERRIDE` still wins over both. Child `agent-coord`
   spawns from the hook layer are pinned to the resolved root via
   `HARNERY_COORD_ROOT_OVERRIDE` so they can't re-resolve differently.
