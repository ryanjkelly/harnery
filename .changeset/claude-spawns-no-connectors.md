---
"harnery": minor
---

Claude Code children that Harnery spawns (`agent()` in `run` workflows and the
`harnery/lib/headless` claude-code backend) now load no MCP servers and no
claude.ai connectors by default. They pass `--strict-mcp-config` with an empty
`--mcp-config` and set `ENABLE_CLAUDEAI_MCP_SERVERS=false`, which keeps about
130 unused connector tool schemas out of every turn. Project settings, hooks,
and `CLAUDE.md` still load. A stage that needs a connector opts in with
`agent(prompt, { mcp: "inherit" })`, or names exactly the servers it needs with
`mcp: { mcpServers: {...} }`; `runHeadless` accepts the same `mcp` field. The
new `ClaudeMcpMode`, `claudeMcpLaunch`, `CLAUDE_NO_MCP_ARGS`, and
`CLAUDE_NO_CONNECTORS_ENV` are exported from `harnery/lib/headless`.
