---
"harnery": patch
---

Load the artifact janitor and the storage maintenance pass at session start instead of on every hook invocation.

Both are called only inside the `session.started` branch, so importing them eagerly made every `pre-tool-use` and `post-tool-use` process load them too. Measured effect on a real hook invocation against an isolated epoch: about 1 MB of the 77 MB resident floor, with no change in wall time. The remaining floor is the V3 recorder and its contract layer, which the hook genuinely needs in order to record an event.
