---
"harnery": patch
---

Two coordination-attribution fixes. Owner resolution via adapter session-id env vars no longer lets a subagent or workflow-child heartbeat outrank the session's own heartbeat when both carry the same session id (in-process subagents inherit the adapter env, and the busiest child could capture the session's journal/decision/artifact writes). And a pre-tool-use guard deny now emits `claim.release` for its targets: the write never happened, but the already-emitted `tool.pre_use` event would otherwise resurrect the path as a held claim on the next heartbeat rebuild and block the end-turn finalization check until a manual release; `readSessionWriteClaims` subtracts these `guard_denied_*` releases while keeping every other release reason in finalization scope.
