---
"harnery": minor
---

Add `harn decision`: a decision docket — a persistent queue for decisions an agent would otherwise escalate to a human. State lives at `.harnery/decisions/` (one manifest per decision + a bodies dir + an archive), mirroring councils. Lifecycle `filed → triaged → deliberating → resolved → enacted → reviewed → archived` (plus `superseded`/`wontfix`), validated through a single transition chokepoint. The engine is generic: it stores a `tier` (0/1/2) + `stakes` but never interprets them — the triage rubric is host policy applied by the filing agent. `resolve` requires ≥1 evidence citation (evidence-free resolutions are bounced). `file`/`resolve`/`review` emit canonical `decision.*` events. Surface: `file|list|show|search|claim|resolve|review|triage`; deliberation dispatch (sweeper, council escalation) and the web UI are intentionally left to a follow-up.
