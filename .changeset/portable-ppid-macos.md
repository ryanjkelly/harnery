---
"harnery": patch
---

fix(agents): portable process-tree walks so owner + anchor resolution work on macOS

Every process-tree walk read `/proc/<pid>/{status,comm}`, which doesn't exist
on macOS/BSD, so the walks died after one hop:

- The two `readPpid` helpers (hook-side `resolve/owner.ts`, CLI-side
  `coord-client.ts`) — owner resolution fell back to session-env / singleton
  heuristics instead of the pid-map ppid walk.
- The anchor-selection comm-walk (`findHarnessAnchorPid` in `hooks/cli.ts` and
  the `agents` diagnostic probe) — returned no anchor, so pid-map self-heal
  relied on `process.ppid` being the harness binary by coincidence.

Added a `ps -o ppid= -p <pid>` / `ps -o ppid=,comm= -p <pid>` fallback after the
`/proc` fast path. `ps` reports `comm` as a full executable path on macOS, so a
new pure, unit-tested `parsePsChainLine` reduces it to the basename to match the
harness comm tokens. The Linux/WSL path is unchanged (still reads `/proc`).
