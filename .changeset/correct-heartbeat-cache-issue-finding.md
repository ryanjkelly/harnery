---
"harnery": patch
---

Correct the `agents health` finding text for heartbeat cache issues. It said the listed rows were files "the sweep isn't reaping", which was true only while the sweep was absent from the reconcile pass. Now that it runs there, a surviving row means the sweep deliberately kept it (malformed but mtime-fresh, or neither audit write could persist) or it aged past the freshness cutoff since the last pass. The old wording reported working behavior as a fault.
