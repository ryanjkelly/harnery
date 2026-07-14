---
"harnery": patch
---

`harn agents show`: correct the command help. It advertised "claude-sessions history (latest title, recent prompts, recent tools, tool-usage tallies)", but standalone harnery never returns that data (the per-peer enrichment is a documented future `context.peerReport` seam that stays null). The help now describes what the command actually reports: registry state (files held, last tool, task, turn summary).
