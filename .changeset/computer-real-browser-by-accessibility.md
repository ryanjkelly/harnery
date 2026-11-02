---
"harnery": patch
---

Correct the `harn-computer` skill's route into the person's signed-in browser. Attaching through `browser_prepare` with an existing profile needs a driver-level grant that covers every agent on the machine, so the skill now tells agents to drive the person's own browser window through accessibility (agent-desktop refs or cua element tokens), which attaches nothing, after the person says yes.
