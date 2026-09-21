---
"harnery": patch
---

Copy the browser Host to X-Forwarded-Host in the tunnel gate so upstream
origin checks can see the public tunnel hostname after the vhost rewrite.
