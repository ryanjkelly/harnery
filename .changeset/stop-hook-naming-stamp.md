---
"harnery": patch
---

fix: the stop-hook naming rule now honors the session-name sighting stamp on the live coordination row. A remediation stop cannot record a fresh turn.completed (the turn's first stop closed the turn span), so when that first terminal lost the transcript flush race and recorded present: false, the rule blocked every retry forever. The stamp written on first sighting is durable evidence the name was shown; the rule consults it before blocking.
