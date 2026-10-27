---
"harnery": patch
---

Stop no longer bounces a Claude Code agent whose foreground command was moved to the background to deliver a user message. While that task is still running, the status-check and status-box demands wait for the turn its completion notification starts; task declaration and session naming stay enforced, agent-chosen background runs and monitors earn no exemption, and a handoff older than 30 minutes stops deferring.
