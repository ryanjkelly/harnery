---
"harnery": minor
---

Hold foreground desktop actions until the person stops typing. A foreground action brings an agent's window to the front and sends real keyboard and mouse input, so anything the person typed at that moment landed in the agent's window. `computer call` now reads how long the keyboard and mouse have been quiet before it sends one, waits for a short quiet period, and exits 5 with nothing sent when the person stays busy. `computer.foreground_quiet_seconds` (default 3, 0 turns it off) and `computer.foreground_wait_seconds` (default 60) tune it. Background actions are not delayed.
