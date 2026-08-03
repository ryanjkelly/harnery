---
"harnery": patch
---

Resolve one coordination root for the hooks and the CLI

With a shell inside a submodule that carries its own `.harnery/`, the Stop hook
and the CLI resolved different coordination roots, and the end-of-turn rules
became impossible to satisfy. The hook walked up from `CLAUDE_PROJECT_DIR`/cwd
and read the submodule's `events.ndjson`; the CLI asked git for the superproject
first, so `agents status` emitted `state.status_checked` into a stream the hook
never opened. Rule 1/3 filters events by `instance_id` within one stream, so a
correctly-scoped event in the wrong file is invisible: every turn blocked, and no
sequence of CLI commands could clear it.

Resolution now follows the session's own heartbeat. `resolveCoordRoot()` is the
single implementation — the hooks' `findCoordRoot()`, the CLI's `monorepoRoot()`,
and `resolveEmitRoot()` all delegate to it — and among the candidate roots
(every enclosing `.harnery/`, nearest first, plus the git-derived roots) it picks
the one whose `active/` already knows this session, falling back to the nearest.
Picking a root by shape was wrong in one direction each: preferring the
superproject stranded a session whose adapter opened the submodule itself, and
walking up from cwd alone stranded the mirror-image case of a superproject
session whose shell had cd'd into a submodule. The session's heartbeat settles
both, and the adapter-exported session id needed to recognize it reaches a plain
tool-call subprocess even though `CLAUDE_PROJECT_DIR` does not. The single-live-
agent fallback is deliberately not a discriminator: a lone stranger in the wrong
root is how `whoami` came to report another agent's name, task, and file list as
its own.

What forced the old behavior was a layout assumption: roughly twenty call sites
built their helper path as `<coordRoot>/harnery/bin/agent-coord`, which exists
only when the root is a superproject carrying harnery as a submodule. Bending
root resolution toward the superproject kept those spawns working. They now
resolve through `coordBinPath()`, which finds the binaries from harnery's own
package location and so works from `src/` under Bun, from `dist/` on Node, and
from `node_modules/harnery`.

Two failures that followed from the same assumption:

- `agents set-task` (and `release-claim`) crashed with "null is not an object
  (evaluating 'result.stderr.trim')" instead of reporting a missing helper.
  `spawnSync` reports `status: null` AND `stderr: null` when the binary cannot be
  executed, so the `status !== 0` branch dereferenced null. Failures are now
  described by `spawnFailureMessage()`, and a helper that cannot be found is a
  named error rather than a crash.
- `agents heal --kind heartbeat --owner <truncated>` minted
  `.harnery/active/<prefix>.json`, a heartbeat no reader resolves, while
  reporting success. Heal now refuses when the owner is a strict prefix of
  `--session-id` or of a live heartbeat's `instance_id`, and names the id to
  retry with. The diagnostics that produced those truncated ids
  (`agents context`, `whoami`, `status`, `council contribute`) quote the owner in
  full, since an abbreviated id in a message whose purpose is to hand back an id
  reads as complete and gets pasted straight into `--owner`.
