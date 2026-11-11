---
"harnery": patch
---

`harn browse` now warns when the cookies from a session could not be saved to the shared store at close. The save error used to be dropped, so a session's cookies could be lost with no message. The browser still closes normally, and `Browser.cookieSaveFault` holds the error for library callers.
