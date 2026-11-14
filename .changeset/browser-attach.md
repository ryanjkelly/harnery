---
"harnery": minor
---

Let a person allow agents to attach to their running browser and work in its tabs (`computer browser-attach on`, where the project sets `computer.browser_attach: true`). Harnery then starts the Cua daemon with its existing-profile grant, `computer call` refuses an attach while the setting is off, and the attach waits for a quiet keyboard and mouse like other foreground actions. `computer status` gains a `browser:` line. The pinned drivers move to Cua Driver 0.49.9 and agent-desktop 1.3.1.
