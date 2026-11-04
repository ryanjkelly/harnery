---
"harnery": patch
---

`--check-placeholder` no longer flags text inside `<code>`, `<pre>`, `<kbd>` or `<samp>`. Those elements show literal text, so an API reference that prints `null` or a `{{click_id}}` link token now passes, while the same tokens in ordinary prose or a bound value still fail.
