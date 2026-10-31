import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeSpawner } from "./spawn-claude.ts";
import type { SpawnRequest } from "./types.ts";

// A fake `claude` on PATH records its argv and the connector env switch, then
// prints a success envelope, so the test exercises the real spawn path.
let binDir: string;
let savedPath: string | undefined;
let savedSwitch: string | undefined;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "spawn-claude-test-"));
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > "${join(binDir, "argv")}"`,
    `printf '%s' "\${ENABLE_CLAUDEAI_MCP_SERVERS-unset}" > "${join(binDir, "switch")}"`,
    `printf '%s' '{"type":"result","is_error":false,"result":"ok","session_id":"s1"}'`,
  ].join("\n");
  writeFileSync(join(binDir, "claude"), script);
  chmodSync(join(binDir, "claude"), 0o755);
  savedPath = process.env.PATH;
  savedSwitch = process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
  process.env.PATH = `${binDir}:${savedPath ?? ""}`;
  delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedSwitch === undefined) delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
  else process.env.ENABLE_CLAUDEAI_MCP_SERVERS = savedSwitch;
  rmSync(binDir, { recursive: true, force: true });
});

const request: SpawnRequest = {
  prompt: "hi",
  timeoutMs: 10_000,
  maxTurns: 1,
  cwd: tmpdir(),
};

describe("claudeCodeSpawner MCP guards", () => {
  test("a default spawn turns connectors off in argv and env", async () => {
    const result = await claudeCodeSpawner(request);
    expect(result.ok).toBe(true);
    const argv = readFileSync(join(binDir, "argv"), "utf8").trim().split("\n");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(argv).not.toContain("--setting-sources");
    expect(readFileSync(join(binDir, "switch"), "utf8")).toBe("false");
  });

  test('mcp: "inherit" leaves Claude Code free to load its connectors', async () => {
    const result = await claudeCodeSpawner({ ...request, mcp: "inherit" });
    expect(result.ok).toBe(true);
    const argv = readFileSync(join(binDir, "argv"), "utf8");
    expect(argv).not.toContain("--strict-mcp-config");
    expect(readFileSync(join(binDir, "switch"), "utf8")).toBe("unset");
  });
});
