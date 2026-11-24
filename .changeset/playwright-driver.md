---
"harnery": minor
---

`computer` gains a third pinned driver, `playwright`, that works in background tabs of the person's running Chrome through the Playwright Extension (ADR 0276). `install --driver playwright` installs a pinned `@playwright/mcp` with `npm ci`, the server runs with the desktop's own Node, and each agent gets its own session and tab group. Its calls leave the desktop lease free except a session's first, the driver refuses typing into password and code fields, a click after typing until a snapshot, and unchecked scripts, and `done`, `lease release` and `browser close` close the agent's tabs. Drivers can now declare `usesDesktop: false`, refuse a call through `checkCall`, and end an agent's work through `endAgentWork`.
