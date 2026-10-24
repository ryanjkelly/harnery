---
"harnery": patch
---

Under WSL, copy a site's cookies from the Windows sign-in profile before each headless `browse` run when the profile changed since the last copy and is closed, so a sign-in made in that window outside a waiting `--login` run reaches headless runs. An open profile is left alone with one log line. Add `browse --sync-login <url>` to run the copy on demand, and `HARNERY_BROWSER_LOGIN_SYNC=off` to turn the automatic copy off.
