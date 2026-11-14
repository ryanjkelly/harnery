---
"harnery": minor
---

Keep agents in their own window of the person's browser. `computer browser open [url]` opens a new window in the person's front-most Chromium browser, attaches and binds it, and prints the ids the driver's browser tools need; `computer browser close` ends the agent's browser sessions and closes its windows, and `done` and `lease release` do the same. `computer call` now refuses (exit 4, nothing sent) a bind of a window the agent did not open unless `--person-window` is passed, a target it did not bind, typing into a password or code field, a click after typing without a fresh read of the tab, a click while a password manager's offer shows, and a `run_script` program that names browser tools. `call` also starts an expired driver session again and retries once, `call` and `up` restart a daemon whose version is not the pinned one, and `status` lists agent browser windows that are still open.
