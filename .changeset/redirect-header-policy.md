---
"harnery": minor
---

`fetchWithJar` and `harn fetch` now follow redirects in the client for every
`redirect: "follow"` request, with or without a cookie jar. A cross-origin hop
keeps only `User-Agent`, `Accept`, `Accept-Language`, and `Range` from the
caller's headers, and a cross-origin 307 or 308 on a request other than GET or
HEAD throws instead of resending the body. Same-origin hops are unchanged. The
`clientRedirects` fetch option and `HarneryProgramContext.clientRedirects` hook
are removed because client-side following is now always on.
