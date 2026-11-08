---
"harnery": minor
---

Agent sign-in is now a per-person setting, off by default. A project that sets `computer.sign_in: true` lets each person run `harn computer sign-in on` (or use the new Off/On choice on the dashboard's Permissions page), which asks them in a Yes/No pop-up first. With it on, the `harn-computer` skill tells agents to sign in to websites in the person's own browser by choosing the matching login in their password manager's extension, never typing credentials; locked vaults, passkeys, hardware keys, system prompts and codes sent to the person still go to the person. `harn computer status` shows a `sign-in:` line and reports `sign_in`, `project_sign_in` and `sign_in_source` in JSON. The choice lives in `computer.json` beside the person's mode and never turns on where the project or the person's own desktop mode is off.
