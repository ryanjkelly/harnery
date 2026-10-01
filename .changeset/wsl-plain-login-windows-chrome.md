---
"harnery": minor
---

Under WSL, `browse --login --plain` now opens the Windows host's Google Chrome on a dedicated Windows profile, because some sign-in flows (X) reject every browser running inside WSL. When the window closes, Harnery reads that profile's cookies for the sign-in site's domain through a short headless DevTools session run from PowerShell and merges them into the cookie store that later `browse` runs attach. `HARNERY_BROWSER_WSL_PLAIN=linux` keeps the previous Linux Chrome behavior.
