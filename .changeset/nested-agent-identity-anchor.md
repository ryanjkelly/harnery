---
"harnery": patch
---

Owner resolution no longer lets an inherited foreign-adapter session-id
environment variable hijack a nested agent's identity: on a cross-adapter
conflict, the nearest token-verified pid-map anchor (claude-code/codex) now
outranks the session-env join, while same-adapter conflicts, Cursor's shared
shells, bridge-marked children, and unverified rows keep the existing env-first
order. `harn agents health` also surfaces stop-hook remediation-cap
exhaustions (count, latest, session samples) as an anomaly, so a session whose
end-of-turn evidence never lands is visible without grepping the debug ledger.
