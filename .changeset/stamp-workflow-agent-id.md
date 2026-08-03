---
"harnery": patch
---

Stamp `HARNERY_WORKFLOW_AGENT_ID` into workflow children, so a dashboard can tell
which agent row a live child session belongs to rather than only which run.

A child cannot be identified by its session id while it is working: the adapter
mints that id and reports it back only in the result envelope, which is to say
only once the work is over. Passing in the id the orchestrator already owns is
what makes live per-agent attribution possible. The engine supplies it at
dispatch, every spawn adapter forwards it, `session.start` carries it as
`workflow_agent_id`, and the heartbeat projector puts it on the child's heartbeat
beside `workflow_run_id`.
