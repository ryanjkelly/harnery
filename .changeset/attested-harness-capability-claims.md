---
"harnery": minor
---

Bench results now state the basis they were established on, and the bench
checks the installed vendor contract.

Every `BenchResult` carries a `basis` of `adapter` (checked against Harnery's
own planner, normalizer, or fixture), `attested` (checked against the installed
vendor CLI), or `declared` (not checked). The report gains a `basisSummary`
rollup. Previously a clean bench read as "no disagreement found" when the
accurate reading was usually "no vendor behavior was observed".

A new `contract` dimension compares the vendor CLI version a profile's
declaration was validated against with the version the installed binary
reports, and raises `drift` when they differ. The `verified` field on
`HarnessProfile` was inert before this change.

`harn harness bench` keeps its surface, its exit-on-drift contract, and its
behavior on hosts with no vendor CLI installed. The text report gains a BASIS
column; the JSON report is extended, not reshaped.
