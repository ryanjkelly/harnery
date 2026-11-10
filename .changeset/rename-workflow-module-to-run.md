---
"harnery": minor
---

**Breaking:** the public export `harnery/core/workflow` is now `harnery/core/run`, matching the `harn run` command. The source folder moved from `src/core/workflow/` to `src/core/run/`, and the command module from `src/commands/workflow.ts` to `src/commands/run.ts`. There is no alias. To migrate, change the import path from `harnery/core/workflow` to `harnery/core/run`; every exported name is unchanged. Stored state, event kinds, config keys, environment variables and CLI commands keep their existing names.
