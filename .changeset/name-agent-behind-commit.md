---
"harnery": minor
---

Name the agent behind a commit in progress. The pre-commit hook records which session is committing until `post-commit` clears it, and the new `agents git-activity` command lists those commits with the repository, elapsed time and the build slots the session holds. Admission holders now record the queueing session (`instance_id`, `agent`), and `admission status` prints `label (agent-Name, pid N)`. Finalization refusals name peers whose commits are still running in an affected repository, and `agents status --end-turn` issues the box with a warning, instead of refusing, when the only findings are freshness findings that every affected repository's in-progress peer commit explains. Findings about the session's own work still refuse. See ADR 0279.
