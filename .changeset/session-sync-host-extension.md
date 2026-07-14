---
"harnery": patch
---

Core hooks no longer hardcode a host-specific `claude-sessions sync` command. The Claude Code turn-stop / session-end effect that synced session telemetry named a command that only the embedding host provides, so a plain public install spawned a doomed (best-effort, ignored) process every turn. Core now fires an optional host extension script at `scripts/hooks/harness/claude_code/extensions/session-sync.sh` under the coord root instead (the same pattern `runTurnSummary` already uses), passing a force flag as argv. A host that wants session telemetry drops that script in; a plain install spawns nothing. Keeps `src/core/` free of host command names.
