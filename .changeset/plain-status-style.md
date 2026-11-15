---
"harnery": minor
---

Add a plain end-of-turn status for readers who do not read code. Set `agents.statusStyle` to `"plain"` (project, user, or machine-local `.harnery/config.local.jsonc`; `HARNERY_STATUS_STYLE` overrides) and `agents status` prints at most three everyday lines instead of the box: what the agent is working on and whether it is in progress, waiting, or finished; how many other agents are active, with a warning only when one holds a file this session touched; and a "Heads up" line for anything the box would flag. `--full` lists every fact on its own line. The Stop hook accepts the plain paste with the same structural checks as the box. The default stays `"box"`.
