---
"harnery": minor
---

Breaking: remove durable work, the governor and councils (ADR 0238).

- The `harn work`, `harn governor` and `harn council` commands are gone. Scripts that call them now fail with an unknown-command error.
- Five package exports are removed: `./core/work`, `./core/work/state`, `./core/governor`, `./core/governor/state` and `./core/governor/plans`. Importers must drop them.
- `harn init` no longer installs the `harn-team` and `harn-council` skills, and the generated agent instructions no longer describe teams or councils.
- The dashboard drops the `/work`, `/governors` and `/councils` pages and the `/api/councils` routes.
- Workflow scripts no longer receive `ctx.work` or `ctx.attempt`. The `WorkflowWorkContext` and `WorkflowAttemptContext` types, their helpers, and the `WORKFLOW_WORK_CONTEXT_SCHEMA_VERSION` and `WORKFLOW_ATTEMPT_CONTEXT_SCHEMA_VERSION` constants are removed.
- The workspace provider's `cancelWorkspace` export and its `CancelWorkspaceInput` type are removed; only work items used them.
- Stored run manifests keep their work-item fields as read-only history, so older runs still load. `harn run integration prepare` refuses a run whose workspace a work item owned.
- `harn run integration prepare` now requires `--reviewer <name>` and says so before doing any work.
- `harn init` removes Harnery-generated skill folders whose skill it no longer ships, so existing projects lose their `harn-team` and `harn-council` folders. Folders without Harnery's generated marker are left alone.
- The supervisor no longer discovers a governor service, and the storage catalog drops the `governor-service`, `governor-service-log`, `governor-history`, `work-item-history`, `council-history` and `agent-mailbox-history` entries.

Durable execution is retired without a replacement: nothing in Harnery restarts, retries or accepts a long objective on its own any more. `harn run` still runs a scripted fan-out, and a run that parks for approval is still resolved with `harn approval`. Records already stored under `.harnery/work`, `.harnery/governors`, `.harnery/governor-service`, `.harnery/councils` and `.harnery/mailbox` are no longer read; archive them before deleting them if you want to keep them. `harn storage retire <name>` removes each of those folders after a preview.
