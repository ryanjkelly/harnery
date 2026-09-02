---
"harnery": patch
---

Keep an attributable coordination projection defect inside its own session.
The coordination view now partitions global diagnostics from diagnostics tied
to one generation, and unaffected sessions remain able to declare tasks, claim
files, and complete finalization. Canonical reader failures and shared claim or
decision-state failures still close the global authority gate. `agents health`
reports isolated diagnostics immediately, including the affected generation
IDs and diagnostic codes.
