---
"harnery": patch
---

Send a cookie with no leading-dot domain (host-only) to its exact host only, in `fetch`, `cookies header` and every redirect hop. Domain cookies still reach subdomains. `fetch` now follows redirects itself whenever a cookie jar is in use, so each hop takes its Cookie header from the jar and saves its own Set-Cookie. Set-Cookie parsing drops a Domain that does not cover the response host and cookies that break their `__Host-` or `__Secure-` prefix rules, and browser cookie injection skips such cookies. Secure cookies are also sent to loopback hosts over HTTP, as browsers do.
