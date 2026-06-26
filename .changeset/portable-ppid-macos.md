---
"harnery": patch
---

fix(agents): portable ppid lookup so owner resolution works on macOS

The two `readPpid` helpers (hook-side `resolve/owner.ts` and CLI-side
`coord-client.ts`) only read `/proc/<pid>/status`, which doesn't exist on
macOS/BSD — so the pid-map ancestor walk terminated after one hop and owner
resolution fell back to later heuristics (session-env / singleton). Added a
`ps -o ppid= -p <pid>` fallback after the `/proc` fast path, so the ppid walk
resolves on macOS too. The Linux/WSL path is unchanged (still reads `/proc`).
