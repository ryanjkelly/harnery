---
"harnery": minor
---

New `harn open <url>` opens an http or https address in the person's default browser (Windows and WSL through the URL protocol handler, `open` on macOS, `xdg-open` on Linux) and returns at once; anything else is refused. The `harn-computer` routing uses it when the person asks to see a page, so "show me" works the same in every agent app.