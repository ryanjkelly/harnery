---
"harnery": patch
---

Export `discoverCodexSessionTranscript` from the runtime-telemetry adapter: locate a Codex rollout transcript by session id across the native and WSL-mounted sessions roots when a hook payload carries no `transcript_path`. Codex omits the path on every hook event except Stop, which left evidence-dependent verdicts such as the pending session-name display permanently unverifiable on that adapter.
