---
"harnery": patch
---

Stop the observer publishing a negative sample age, which made the resource
status reader reject its own assessment as malformed on about half of all
cycles. The observer read its clock before sampling, so the snapshot's time sat
a few milliseconds ahead of it. A sample time inside the tolerance now reads as
zero, one beyond it reports an unreadable age with a stale reason instead of a
negative number, and the observer assesses against a clock read after sampling.
