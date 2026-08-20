---
"harnery": patch
---

Keep Windows-hosted Codex identity attached after a WSL process-tree refresh. Payload-free hook and pre-commit guard calls now join the forwarded thread ID to one live V3 generation, reject missing or ended generations without falling back to old PID maps, and remain isolated when several Codex tasks share a checkout.
