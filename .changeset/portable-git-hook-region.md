---
"harnery": patch
---

The managed Git hook regions are now identical on every platform. They used to differ between Windows (`node agent-coord.mjs`) and Linux or macOS (`agent-coord`), so a checkout reached from two systems, such as a Windows folder opened from WSL, flipped between two forms that each reported the other as stale. The region now runs the `.mjs` launcher with Node when Node is on PATH and the POSIX launcher otherwise. Run `init` once to refresh existing hooks.
