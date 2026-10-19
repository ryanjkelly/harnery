---
"harnery": patch
---

Hook signals and authority writes are cheaper. Each hook signal no longer takes a second generation-custody lease, and each authority write no longer rereads every producer state file to confirm the writer's generation. A workflow child still publishes `agent.end`, the resume-cache boundary, only after its terminal is recorded, and a terminal recording failure now fails the run instead of being logged. This reverts the generation-custody part of 0.44.0 (ADR 0214, now withdrawn).
