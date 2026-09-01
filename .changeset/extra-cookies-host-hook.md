---
"harnery": minor
---

Add a synchronous `extraCookies` host hook so embedding CLIs can mint
session cookies into the shared jar before `fetch` and `browse` attach
it. `--no-cookies` skips the hook. `extraHeaders` cannot merge a Cookie
header once the jar has already set one.
