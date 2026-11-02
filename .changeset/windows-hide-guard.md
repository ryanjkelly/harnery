---
"harnery": patch
---

Every child process Harnery starts now passes `windowsHide: true`, so a background process on Windows no longer opens a terminal window when it runs git, ps, rclone, ripgrep, an adapter CLI or any other console program. The earlier fix covered the paths that had been seen opening windows; this one covers the remaining 65 calls. The two `--login` launches of Google Chrome stay visible on purpose, because the person signs in to that window. A new check, `bun run check:windows-hide`, which also runs as a unit test, fails when a `node:child_process` or `Bun.spawn` call in `src/` leaves the option out. A call that is meant to show a window carries a `// windows-hide-allow: <reason>` comment on its line or the line above.
