---
"harnery": patch
---

Make connector-marked owner attribution require a heartbeat-validated session identity. Codex commands crossing the Windows-to-WSL bridge now fail unattributed instead of falling through to a foreign PID or singleton owner, hook and CLI resolvers share session-before-PID precedence, and command events record their owner-resolution source and bridge marker.
