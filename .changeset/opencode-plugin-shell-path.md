---
"harnery": patch
---

The OpenCode plugin prepends the project's `bin/` directory and an existing
Bun install directory to each tool shell's PATH, so bare project launchers
resolve in sessions whose server started from a minimal environment.
