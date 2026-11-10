---
"harnery": minor
---

Breaking: remove durable work, the governor and councils (ADR 0238).

- The `harn work`, `harn governor` and `harn council` commands are gone. Scripts that call them now fail with an unknown-command error.
- Five package exports are removed: `./core/work`, `./core/work/state`, `./core/governor`, `./core/governor/state` and `./core/governor/plans`. Importers must drop them.
- `harn init` no longer installs the `harn-team` and `harn-council` skills, and the generated agent instructions no longer describe teams or councils.
- The dashboard drops the `/work`, `/governors` and `/councils` pages and the `/api/councils` routes.
- Workflow scripts no longer receive `ctx.work` or `ctx.attempt`.
- The supervisor no longer discovers a governor service, and the storage catalog drops the `governor-service`, `governor-service-log`, `governor-history`, `work-item-history`, `council-history` and `agent-mailbox-history` entries.

Durable execution is retired without a replacement: nothing in Harnery restarts, retries or accepts a long objective on its own any more. `harn run` still runs a scripted fan-out, and a run that parks for approval is still resolved with `harn approval`. Records already stored under `.harnery/work`, `.harnery/governors`, `.harnery/governor-service`, `.harnery/councils` and `.harnery/mailbox` are no longer read; archive them before deleting them if you want to keep them.
