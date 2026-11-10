---
"harnery": patch
---

`init` now removes a generated skill folder that Harnery no longer ships from every adapter's skill directory, not only the active adapter's. A project initialised for Claude Code that also carried `.agents/skills/` copies kept the retired `harn-team` and `harn-council` folders there.
