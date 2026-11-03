---
"harnery": patch
---

Respect Set-Cookie default paths and Max-Age precedence, reject malformed Max-Age values, and keep deletion cookies expired even when their date predates the Unix epoch. Correct the fallback parser for combined Set-Cookie headers without splitting Expires dates.
