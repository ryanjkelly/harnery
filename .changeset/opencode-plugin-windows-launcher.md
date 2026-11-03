---
"harnery": patch
---

The OpenCode plugin runs on Windows. When `harnery.json` names a launcher path, the plugin used to spawn it with `bash`, which cannot run the POSIX launcher script on Windows; it now runs the launcher's sibling `run.mjs` through Node, the same command `harn init` writes for native Windows hooks. Tool shells also get the Bun install directory on their PATH when it holds `bun.exe`.
