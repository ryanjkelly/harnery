---
"harnery": patch
---

`harn fetch` is now signed in after `harn browse --login` on Windows, macOS, and Linux, not only under WSL. When the plain sign-in window closes, Harnery reopens the browse profile headless with the same installed Google Chrome, reads the cookies for the sign-in site's registrable domain and its subdomains, and merges them into the shared cookie store that `fetch` reads. Cookies for other domains are never copied. A failed read is a warning and the sign-in still stays in the profile; `--no-cookies` or `HARNERY_BROWSER_LOGIN_SYNC=off` skips the copy.
