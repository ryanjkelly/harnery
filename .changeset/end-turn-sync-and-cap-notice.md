---
"harnery": minor
---

Add `agents.gitSyncOnEndTurn` (project-only, default `false`). When it is on and the only end-turn findings are that the checkout is behind its upstream or a submodule checkout trails its gitlink, `agents status --end-turn` runs `agents.gitSyncCommand` once with a two-minute limit, repeats the full check, and reports what the sync brought in on a new `sync` row. Owned dirty or unpushed work, diverged submodules, and failed or incomplete syncs still refuse. When the Stop remediation cap lets a turn end, Claude Code now shows the person a `systemMessage` notice, and the session's next prompt tells the agent which rule went unmet, to fix it, and to tell the person in one plain sentence. Every finalization refusal now leads with one plain sentence and the exact command to run.
