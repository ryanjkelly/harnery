---
"harnery": patch
---

`docs lint` and `docs metadata sync` now name the accepted values when they
reject a document's `status`, a `relations` key, or an `access` field. For
example, a plan with `status: active` reports "use one of: proposed,
in-progress, shipped, abandoned", so the fix needs no trip to the validator.
