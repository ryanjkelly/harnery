---
"harnery": patch
---

`--check-runts` no longer flags the last wrapped line inside a `<pre>` block. A soft-wrapped code sample cannot be reworded, so a short final line there is not a prose runt. Inline `<code>` inside a sentence is still checked.
