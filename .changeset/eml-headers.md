---
"harnery": patch
---

`eml --headers` now renders the source message's full headers. The flag was registered and documented but its value was never read (a silent no-op); it now emits a "Source headers" block from the parsed `.eml`. (A Gmail thread export is a single `.eml`, so there is one real header set — the prior "per message" wording was corrected.)
